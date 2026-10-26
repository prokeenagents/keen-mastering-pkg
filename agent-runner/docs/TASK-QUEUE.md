# TaskQueue — the client-side flow orchestration engine

> Deep reference for `sdk/task-queue.ts` and the frames it exchanges with the Keen server.
> Written for someone building their own client on `sdk/`, or debugging a live run.
> Every load-bearing claim cites `file:line` **verified against the `agent-runner/sdk/`
> code**. Where an existing doc or a comment disagrees with that code, this document
> trusts the code and says so in a **⚠️ Note**.

**Provenance.** `agent-runner/sdk/` is functionally identical to entanglement's ChatSDK
(comment-only drift; `KeenChat` + `HOW_TO_USE` not included). The `App.Chat.*` ambient types the
SDK references (every `chat.d.ts` anchor below) live in entanglement's `src/@types/chat.d.ts` —
agent-runner does not ship them, `tsx` runs the SDK untyped. The
canonical prose already exists and this document **consolidates** it rather than
reinventing it — read those as companions, but note the `file:line` anchors here are the
**agent-runner** copy (line numbers differ slightly from the Test WS React tree).

> **Not in this package.** The companion docs below, `HOW_TO_USE.md`, and the server-side
> anchors (`relay.gateway.ts` = the Keen relay's source) live in the maintainers' repos; they are
> cited for provenance only. `chat.d.ts` is in the reference partner site —
> `/keen-entanglement-download` puts it at `<site>/src/@types/chat.d.ts`. Everything this
> document claims is checkable against `agent-runner/sdk/` alone.

| Existing doc | Covers |
|---|---|
| `Test WS React/docs/DRIVE-LOOP.md` | the drive loop = TaskQueue orchestration (most relevant) |
| `Test WS React/docs/DECISIONS.md` | the non-obvious calls (the "dragons") — cited as **[D§N]** below |
| `Test WS React/docs/SDK-LAYERING.md`, `LIFECYCLE.md`, `MODULES.md`, `ARCHITECTURE.md` | where TaskQueue sits, why the client drives |
| `entanglement/src/service/services/chat/HOW_TO_USE.md` (not copied into `agent-runner/sdk/`) | consumer usage |

---

## Table of contents

1. [Role & mental model](#1-role--mental-model)
2. [The full lifecycle, in order](#2-the-full-lifecycle-in-order)
3. [The wire formats — every frame](#3-the-wire-formats--every-frame)
4. [The node-task drain loop](#4-the-node-task-drain-loop)
5. [Parallel fan-out](#5-parallel-fan-out)
6. [Tool dispatch & virtual nodes](#6-tool-dispatch--virtual-nodes)
7. [Identity & keys](#7-identity--keys)
8. [Retries & status codes](#8-retries--status-codes)
9. [Cancel & teardown](#9-cancel--teardown)
10. [Heartbeat](#10-heartbeat)
11. [What to expect on `onStream`](#11-what-to-expect-on-onstream)
12. [Consumer quick-start](#12-consumer-quick-start)
13. [Constants reference](#13-constants-reference)
14. [Divergences from the existing docs](#14-divergences-from-the-existing-docs)

---

## 1. Role & mental model

The Keen flow engine is a **pure per-node function**:

```
(cid, nodeId, payload) → { result, nextNodeTasks }
```

It executes exactly one node when asked, returns that node's result plus a hint about
which node(s) come next, and then **stops**. It does **not** chain to the next node on
its own, and it does **not** retry on its own. It holds per-`cid` state (dictionary,
session, agent-state, tree-context, cookie-storage) in the platform's fast store with a
~60 s TTL, but it never advances the flow without a fresh request.

**TaskQueue is the thing that drives it.** One `TaskQueue` per `ChatAPI` (`index.ts:88`);
a new chat session gets a new one. It owns *all* orchestration: sending the initial prompt
and every per-node continuation, the drain loop over returned `nextNodeTasks`, parallel
fan-out, retries (transport + response), cancel + local teardown, and the heartbeat.

The invariant: **the server is stateless-per-call about *what to do next*; the client is
the state machine.** Everything the engine returns is a *hint* the client chooses to act
on — including bundle-level `completed`/`ready` flags, which the client deliberately
overwrites to `false` on arrival (`scrubInboundNode`, `task-queue.ts:1041`; and in
`normaliseInboundBundle`, `:1382`) because those are *client-owned* execution state, not
server truth **[D§1]**.

**Its place in the stack** (see `SDK-LAYERING.md`):

```
ChatAPI (index.ts)  ──── the only public front door; consumers depend only on this
   ├── TaskQueue        ── orchestration (this document)
   ├── SendRequest      ── one outbound "run" frame + transport-retry loop
   ├── ResponseAPI      ── inbound frame routing (envelope vs stream) + waitFor
   └── WSConnectAPI     ── the raw WebSocket + the welcome/cid capture
```

TaskQueue never touches the socket directly. It calls back *up* into its owning `ChatAPI`
(`chat`, `task-queue.ts:62`) for `send`, `sendNodeTask`, `waitFor`, `sendCancel`,
`sendPing`, `getCorrelationID`, `setCorrelationID`, and the live `accessToken`.
`ChatAPI` is the only public surface; the sub-apis are `readonly` fields, never
barrel-exported **[D§9]**.

---

## 2. The full lifecycle, in order

Entry point: `TaskQueue.run(input)` (`task-queue.ts:76`), reached from `ChatAPI.runFlow`
(`index.ts:103`).

### Step 0 — re-entry guard

`run()` throws immediately if `this.bundles.size > 0` (`task-queue.ts:77`,
`"TaskQueue already running"`). One flow tree at a time per TaskQueue — `await` each turn,
never run two concurrently on one `ChatAPI`.

### Step 1 — resolve the connection cid

```ts
let correlationId = this.chat.getCorrelationID();   // task-queue.ts:91
if (!correlationId) {
    correlationId = generateRequestId();            // dev-only fallback
    this.chat.setCorrelationID(correlationId);      // register on the connection
}
```

The **cid (correlationId) is connection-scoped**, assigned by the Keen server via a `welcome`
frame sent once right after the socket opens (`connect.ts:243`–`265`). If it has arrived,
`getCorrelationID()` returns it; if not, TaskQueue mints a client-side fallback and
registers it (`setCorrelationID`, `connect.ts:155`), which also resolves the
`welcomePromise`.

The fallback is a **deliberate dev affordance [D§7]**, not the primary path. In production
the Keen server always sends `welcome`, and the *consumer* is expected to gate its first
`runFlow` on `await chat.whenReady()` (see §12 and the HOW_TO_USE Step 4). `run()` itself
does **not** internally await `whenReady()` — it reads whatever cid is currently on the
connection and mints a fallback if none exists yet.

### Step 2 — arm running-state + heartbeat

```ts
this.setRunning(true);      // fires onRunning(true) — gates "is a flow in flight" UI
this.startHeartbeat();      // ping every HEARTBEAT_INTERVAL_MS (5s)
```

(`task-queue.ts:111`–`112`.) Both are torn down in the outer `finally`
(`task-queue.ts:224`–`227`) so they flip back on **every** exit path — success, throw, or
cancel. `setRunning` is idempotent (`:1330`). The heartbeat keeps the engine's dict/session
TTLs alive between per-node calls (§10).

### Step 3 — build + send the initial run payload

The `InitialRunPayload` is assembled at `task-queue.ts:135`–`165` (fields in §3.2). It
carries `userContext`, `rootAgentContext`, `chatContext`, a freshly-minted `flowContext`
(`sessionId` + `requestId` both `generateRequestId()`), and `requestContext.cookies` resolved
from `ChatAPIOptions.cookies` (`resolveRequestCookies`, `utils.ts:83`–`89`: an explicit
`{ name: value }` map is forwarded as-is — how a headless caller such as `run.ts --cookie`
supplies them — otherwise a name allow-list is read from `document.cookie`) **on the initial
run only** (`:162`–`164`).

```ts
const requestId = await this.chat.send(payload);     // :167  → frame requestId
const envelope  = await this.chat.waitFor(requestId);// :168  → matching reply
```

`chat.send` → `SendRequest.execute` with `maxRetries = INITIAL_MAX_RETRIES` (10): it mints
a **frame-level** requestId (`send-request.ts:81`), pushes the `run` frame, retries every
1 s until the socket accepts it, returns that frame requestId (`index.ts:196`).
`waitFor(requestId)` parks a promise in `ResponseAPI.pending` keyed by that frame requestId;
it resolves when a response frame with a matching `requestId` and an `envelope` arrives
(`response.ts:50`–`70`), or rejects on `RESPONSE_TIMEOUT_MS` (10 min, `response.ts:96`).

### Step 4 — validate + normalise the root bundle

```ts
if (this.cancelled) throw new Error('TaskQueue cancelled');   // :170
if (!envelope.success) throw new Error(envelope.message ?? envelope.code); // :174
const root = this.normaliseInboundBundle(envelope.data);      // :178
```

`normaliseInboundBundle` (`task-queue.ts:1357`) tolerates deviations: it hoists a sibling
`options` under `flowTask`, forces `flowContext.completed = false`, scrubs every inbound
node's `ready`/`inProgress` to `false` (`scrubInboundNode`, `:1041`), and prepends a
client-only `virtualStartNode` for script-tool bundles (§6).

Degenerate case: no `nodeTasks` → mark completed, register, return the snapshot
(`:185`–`192`). Otherwise capture `rootCorrelationId` (`:194`) and register the root (`:195`).

### Step 5 — the outer drain loop

```ts
while (!this.cancelled && this.hasIncomplete()) {                 // :203
    const incompletes = Array.from(this.bundles.values())
        .filter((b) => !b.flowTask.flowContext.completed);
    await Promise.all(incompletes.map((b) => this.drainBundle(b)));// :208
}
```

Each pass drains every not-yet-completed bundle **in parallel**. Bundles registered during
a pass (parallel children, context clones) are picked up on the next pass. `drainBundle`
(§4) walks one bundle's pending nodes until none remain, then flips `completed = true`
**only if** its parallel dependencies are all ready (`allParallelDependenciesReady`, `:1201`).

### Step 6 — settle

```ts
if (this.cancelled) throw new Error('TaskQueue cancelled');   // :211
return this.snapshotAndClear();                                // :215
```

`snapshotAndClear` (`:1312`) copies the final map, then `clear()`s (empties the map and
`emitUpdate()`s an empty snapshot). `run()` resolves with a frozen
`ReadonlyMap<string, FlowTaskBundle>`.

### The failure boundary

The body sits inside one `try/catch` (`task-queue.ts:134`–`223`). **Any** throw funnels
through one catch that (a) fires `chat.sendCancel()` so the engine wipes every stored
entry under the cid, unless the user already cancelled, and (b) `clear()`s local state, then
re-throws. Cancel is a **blunt instrument** — one spurious terminal error takes down the
whole tree **[D§8]**, which is why the terminal-code classification is kept tight (§8).

### Sequence diagram

```mermaid
sequenceDiagram
    autonumber
    participant C as Consumer
    participant TQ as TaskQueue
    participant CA as ChatAPI
    participant WS as WSConnectAPI
    participant R as Keen server + engine

    C->>CA: connect()
    CA->>WS: connect()
    WS->>R: WS open
    R-->>WS: welcome { correlationID: "<uuid v4>" }
    C->>CA: await whenReady()  (consumer gate)

    C->>CA: runFlow({ chatId, prompt, ... })
    CA->>TQ: run(input)
    TQ->>TQ: resolve cid (the server's, or dev fallback)
    TQ->>TQ: setRunning(true) + startHeartbeat()
    TQ->>CA: send(InitialRunPayload)
    CA->>WS: sendFrame({event:'run', data:{requestId, payload}})
    WS->>R: run frame
    R-->>WS: response { requestId, envelope:{ data: root bundle } }
    WS->>CA: ResponseAPI.handle → resolve waitFor(requestId)
    CA-->>TQ: envelope (root FlowTaskBundle)
    TQ->>TQ: normaliseInboundBundle + registerBundle(root)

    loop drain until every bundle completed
        TQ->>TQ: drainBundle(b) → pending nodes
        loop each pending node
            TQ->>CA: sendNodeTask(NodeTaskRequest)  (lean, no rootAgentContext)
            CA->>WS: run frame
            WS->>R: run frame
            R-->>WS: response envelope
            WS-->>TQ: envelope → push nextNodeTasks / spawn / final
        end
    end

    Note over R: EndNode → { final:true, flowContext }
    TQ->>TQ: isEndOfFlowSignal (4-id match) → bundle completed
    TQ->>TQ: stopHeartbeat() + setRunning(false)
    TQ-->>CA: ReadonlyMap<key, FlowTaskBundle>
    CA-->>C: final bundle map
```

---

## 3. The wire formats — every frame

### 3.1 The six sibling context blocks

The wire model is **flat**: there is no `root` wrapper. Identity is grouped into named
sibling blocks. A full `FlowTask` (`chat.d.ts:491`) carries all six; individual payloads
carry a subset.

| Block | Fields | Scope | Sent by client on… |
|---|---|---|---|
| `userContext` | `userId`, `email`, `accessToken?` | tree-invariant identity | initial + every per-node (accessToken **re-stamped every frame**) |
| `rootFlowContext` | `flowId`, `correlationId`, `sessionId`, `requestId` | tree root identity (engine-set once) | every per-node (**not** on the initial payload) |
| `rootAgentContext` | `agentId`, `prompt` | the agent + user prompt | initial only (**dropped** from the lean NodeTaskRequest) |
| `chatContext` | `chatId`, `projectId` | conversation + project | initial + every per-node + every clone |
| `flowContext` | see 3.5 | **per-call** flow identity | every frame (shape varies root vs child) |
| `options` | `Record<string, unknown>` | bundle-level tool/side-band pack | inside the bundle; seeded onto node sends for tool flows |

**Tree-invariant** (identical start → end): `userContext`, `rootFlowContext`,
`rootAgentContext`, `chatContext`. **Per-flowTask** (differs per bundle/call): `flowContext`,
`options`.

`accessToken` is the one field not echoed untouched. The Keen server verifies it **per message**
(`verifyWithChain` + `token.sub === userId`), and the server-echoed `userContext` on
continuations/children **drops** it — so TaskQueue re-stamps `this.chat.accessToken` onto
every outbound frame's `userContext` (`task-queue.ts:454`, `:1233`). This is the intended,
documented behavior (HOW_TO_USE Step 1); see §14 for the stale comments that claim otherwise.

### 3.2 `InitialRunPayload` — SENT on the first frame

Built at `task-queue.ts:135`–`165`, wrapped as `{ event:'run', data:{ requestId, payload } }`.

| Field | Type | Meaning |
|---|---|---|
| `userContext.userId` | string | `input.userId ?? chat.userId` (**must equal the token's `sub`**) |
| `userContext.email` | string | `input.email ?? chat.email` |
| `userContext.accessToken` | string | `chat.accessToken` (live value) |
| `rootAgentContext.agentId` | string | `input.agentId ?? chat.agentID` — the agent slug |
| `rootAgentContext.prompt` | string | the user's prompt text |
| `chatContext.chatId` | string | `input.chatId` (REQUIRED — the chat_history key) |
| `chatContext.projectId` | string | `input.projectId ?? chat.projectID` (== space id) |
| `flowContext.correlationId` | string | the connection cid from step 1 |
| `flowContext.sessionId` | string | freshly minted `r-<uuid>` |
| `flowContext.requestId` | string | freshly minted `r-<uuid>` (flow-tree requestId, **not** the frame requestId) |
| `requestContext.cookies` | `Record<string,string>` | from `ChatAPIOptions.cookies` — an explicit map used as-is (headless) or an allow-list of names read from `document.cookie` (HttpOnly never visible); initial run only → the engine stores them for the run |

The initial payload carries **no `rootFlowContext`** — the engine sets it once in
`runInitialPayload` and echoes it in the bundle. `chat.d.ts:177` declares
`flowContext.correlationId` optional, but TaskQueue always populates it.

### 3.3 `NodeTaskRequest` — SENT per node (LEAN)

Built at `task-queue.ts:447`–`490`, sent via `chat.sendNodeTask` (`index.ts:216`).
**Lean by design** — it drops `rootAgentContext`. The engine resolves the prompt via
`agentStateMgr.getRootAgentPrompt(cid, agentId)` and agentId via the run's tree-context
written at init (`chat.d.ts:307`).

| Field | Type | Meaning |
|---|---|---|
| `userContext` | UserContext | `{ ...flow.userContext, accessToken: chat.accessToken }` — token re-stamped |
| `rootFlowContext` | RootFlowContext | the tree root's `{flowId, correlationId, sessionId, requestId}`, verbatim |
| `chatContext` | ChatContext | `{chatId, projectId}`, verbatim |
| `flowContext` | FlowContext | the per-call context (see 3.5) |
| `nodeContext.id` | string | which node to run |
| `nodeContext.kind` | string | node kind (agentNode, scriptNode, endNode, …) |
| `nodeContext.initial?` | boolean | present only if set; drives the retry-bound policy (§8) |
| `options?` | `Record<string,unknown>` | tool side-band (see §6) |

### 3.4 `ContextRunPayload` — a DEFINED shape the current TaskQueue does NOT send

`ContextRunPayload` (`chat.d.ts:354`) and `ChatAPI.sendContextRun` (`index.ts:235`) are
fully defined, but **TaskQueue never emits either.** For a `parallelContext` fan-out it
clones the template bundle locally and drains each clone through the ordinary per-node
`NodeTaskRequest` path (the in-code comment says so, `task-queue.ts:1105`–`1117`). This is
**deliberately dormant** — the seed of a future large-N wire optimization; do not delete it
in a cleanup pass **[D§3]**.

### 3.5 `FlowContext` on the wire (per-call)

Assembled as `outgoingFlowContext` (`task-queue.ts:403`–`445`). Only present fields are
spread onto the wire:

| Field | Always? | Meaning |
|---|---|---|
| `correlationId` | yes | this bundle's cid |
| `sessionId` | yes | this bundle's session |
| `requestId` | yes | this bundle's flow-tree requestId |
| `flowId` | **only if non-root** | root omits it — engine reads it from `rootFlowContext.flowId`. `isRoot = rootFlowContext.flowId === fc.flowId && !parentFlowId && contextNumber === undefined` (`:399`) |
| `currentFlowId` | if present | the dict-owning flow; a runFlow/jumpFlow child inherits its spawner's so it stays on the calling flow's dict |
| `parentFlowId` | if present | immediate spawner's flowId |
| `parentSessionId` | if present | "use the parent's session key" — set only on parallel siblings (§5.1). Engine resolves the session key as `parentSessionID ?? sessionID` **[D§5]** |
| `contextNumber` + `contextPath` | if `contextNumber` is a number | parallelContext clone coordinates; forwarded every call so the engine's dict seam fires for the clone's whole life |
| `correlationToken` | if present | per-call auth seal; absent until auth.utils mints it on the initial run |

### 3.6 `OutboundFrame` — the three frames TaskQueue causes

`chat.d.ts:384`–`408`:

| `event` | `data` | Meaning |
|---|---|---|
| `run` | `{ requestId, payload }` | initial run or per-node continuation. `requestId` is the **frame** id (`send-request.ts:81`) |
| `cancel` | `{ correlationId }` | tear down dict/session/agent-state/queue for the cid (`index.ts:304`) |
| `ping` | `{}` | heartbeat; the Keen server derives the cid from the socket (`index.ts:326`) |

### 3.7 Inbound response envelope

`ResponseAPI.handle` (`response.ts:50`) splits inbound frames by **envelope presence**:
`frame.data.envelope` present → resolve the matching `waitFor` and fire `onResponse`;
absent → fire `onStream` (§11). The `Envelope` (`chat.d.ts:13`):

| Field | Type | Meaning |
|---|---|---|
| `success` | boolean | true → act on `data`; false → error path |
| `code` | string | status code `E1xxx…E8xxx` (§8) |
| `message?` | string | human message |
| `data?` | unknown | the per-node result; TaskQueue discriminates its shape (below) |

**`envelope.data` shapes**, discriminated in `runRegularNode` after `envelope.success`
(`task-queue.ts:568`–`672`), in this priority order:

| Shape | Detector | Handler |
|---|---|---|
| `{ final:true, flowContext:{flowId,correlationId,sessionId,requestId} }` | `isEndOfFlowSignal` (`:950`) | mark bundle completed |
| `{ childFlows:[{flowTask,nodeTasks}, …], nodeTasks?:[…] }` | `isSpawnedChildrenResponse` (`:721`) | `handleSpawnedChildren` (§5.1) |
| `{ parallelContextTask:{flowTask,total}, nodeTasks?:[…] }` | `isSpawnedContextResponse` (`:846`) | `handleSpawnedContext` (§5.2) |
| `{ nextNodeTasks:[…] }` / `{ nodeTasks:[…] }` / single NodeTask / FlowTaskBundle echo | `extractIncomingNodes` (`:983`) | push fresh nodes onto the bundle |

### 3.8 The spawn shape — `childFlows`

`{ childFlows: [ { flowTask, nodeTasks }, … ], nodeTasks?: [ …parent continuation… ] }`.
Each `childFlows[i].flowTask.flowContext.parentFlowId` **must** equal the spawning bundle's
`flowContext.flowId` (validated per-entry, `:784`; a mismatch throws). The parent's
continuation `nodeTasks` are pushed **only after** all children drain (§5.1).

### 3.9 The endNode terminator

```
{ final: true, flowContext: { flowId, correlationId, sessionId, requestId } }
```

`isEndOfFlowSignal` (`task-queue.ts:950`) requires `final === true` **and all four ids** to
match *this bundle's* `flowContext` (`:969`–`974`). The 4-id match is an integrity check: a
`final:true` with mismatched ids is a misroute and is **not** acted on (the bundle then
never naturally completes, but at least the wrong bundle isn't marked done). On a match:
`completed = true`, `node.ready = true`; a `virtualScriptNode` also appends a client-only
`virtualEndNode` (§6).

> **⚠️ Note:** `DRIVE-LOOP.md §4` says "the three ids must match"; the agent-runner code
> matches **four** (adds `flowId`). Code is authoritative.

---

## 4. The node-task drain loop

A `NodeTask` (`chat.d.ts:570`) is the wire shape `{ flowContext, nodeContext, options? }`
plus **client-owned** execution state the server never sees: `inProgress`, `ready`,
`response?`, and the normalised parallel-host references.

### 4.1 Three-state model

| State | Meaning | Set where |
|---|---|---|
| pending | `!inProgress && !ready` — needs firing | initial state after `scrubInboundNode` (`:1041`) |
| in-progress | a send is in flight | `processNode` sets `inProgress=true` (`:351`) |
| ready | node is done (result received / children settled) | `runRegularNode` (`:669`), `maybeMarkParallelHostReady` (`:1149`) |

`scrubInboundNode` forces `ready`/`inProgress` to `false` on **every** inbound node — the
engine's optimistic `ready:true` is not trusted, otherwise the drain filter finds nothing
pending and the bundle "completes" without executing anything (`task-queue.ts:1027`–`1040`)
**[D§1]**.

### 4.2 `drainBundle` (`task-queue.ts:305`)

```
while not cancelled:
    pending = nodeTasks.filter(n => !n.inProgress && !n.ready)   // :311
    if pending is empty: break
    await Promise.all(pending.map(processNode))                  // :317
if allParallelDependenciesReady(bundle):
    bundle.flowContext.completed = true                          // :332
```

Every pending node fires **in parallel** each iteration; the loop repeats because a node's
response can push *new* pending nodes onto `nodeTasks`. The bundle is marked completed
**only if** every parallel-host node's referenced children are all completed
(`allParallelDependenciesReady`, `:1201`).

### 4.3 `processNode` (`task-queue.ts:346`) — the dispatch switch

```
if cancelled || ready || inProgress: return
inProgress = true
try:
    if node.parallelFlowTask is inbound bundle-array   → normaliseParallelFlowTask
    else if node.parallelContextTask is inbound object → normaliseParallelContextTask
    else if node is already a normalised parallel host → maybeMarkParallelHostReady
    else                                               → runRegularNode
finally:
    if not ready: inProgress = false
```

### 4.4 `runRegularNode` — the per-node send + push-back

1. Build `outgoingFlowContext` (§3.5) and the lean `NodeTaskRequest` (§3.3).
2. Response-retry loop (§8): `sendNodeTask` → `waitFor`, stamp `node.response = envelope`
   (`:566`, for the inspector).
3. On `success`, discriminate `envelope.data` (§3.7): end signal → complete; spawn/context
   → hand off (§5); otherwise `extractIncomingNodes(data)` → **dedup against pending ids
   only** → `bundle.nodeTasks.push(...fresh)` → `node.ready = true`.

**Why dedup only against *pending* entries** (`:659`–`666`) **[D§2]**: a server that
re-echoes a currently-queued node (infinite-loop guard) is filtered out, while a
`jumpFlowNode` legitimately re-returning a node whose id already *ran* gets pushed as a
**fresh** entry — so a loop's nodeTasks array grows by one per iteration.

`extractIncomingNodes` (`:983`) accepts four "next nodes" carriers: `{ nextNodeTasks:[…] }`,
`{ nodeTasks:[…] }`, a bare single NodeTask (`looksLikeSingleNodeTask`, `:1013`), or a full
`FlowTaskBundle` echo. It is now a **pure pass-through** that only re-scrubs flags — the old
ToolNode envelope translation was removed.

> **⚠️ Note:** `NodeTask.nextNodes?: string[]` (`chat.d.ts:632`) is declared but **never
> read** by TaskQueue — next-node info flows via `envelope.data`.

---

## 5. Parallel fan-out

Three spawn shapes, all normalised to **bundle-id arrays** so the tree stays flat. The host
node only goes `ready` when *every* referenced child bundle is `completed`
(`maybeMarkParallelHostReady`, `:1139`). Two entry paths per kind: **envelope-carried** (the
primary path — the spec ships the fan-out in `envelope.data`) and **node-carried** (a node
that arrives already holding the inbound object form).

| Node type | Wire shape | Session | Dict | Drain strategy |
|---|---|---|---|---|
| `runFlowNode` | `{ childFlows:[{flowTask,nodeTasks}], nodeTasks:[parent continuation] }` | child has own | tree dict (`root.flowId`) | `Promise.all` all children |
| `parallelInNode` | `parallelFlowTask: FlowTaskBundle[]` | **shared** via `parentSessionID ?? sessionID` **[D§5]** | tree dict | `Promise.all` all siblings |
| `parallelContext` | `parallelContextTask: { flowTask: template, total }` | **independent** per clone | **own** dict per clone (seed→merge→delete, engine-side) | **batched** (15 at a time), envelope path only |

### 5.1 Spawned children (`runFlowNode`) — `handleSpawnedChildren` (`:773`)

1. Normalise + validate each child (`parentFlowId` must match the bundle, `:784`),
   `registerBundle` each.
2. Attach child keys to `node.parallelFlowTask` as `string[]` (`:795`).
3. `await Promise.all(childBundles.map(drainBundle))` — settles on the **slowest** child
   (`:804`).
4. `maybeMarkParallelHostReady(node)` (`:810`).
5. **Only then** push the parent's continuation `nodeTasks` (deduped against pending)
   (`:826`–`838`).

Load-bearing ordering: **register → attach keys → drain all → mark host ready → THEN push
the parent's continuation.** Pushing earlier would let the parent's next nodes race their
own children. Node-carried variant: `normaliseParallelFlowTask` (`:1056`).

### 5.2 parallelContext — `handleSpawnedContext` (`:870`)

The engine sends **one template bundle + `total`** — O(1) on the wire regardless of N.

1. `cloneBundleForContext(bundle, template, index)` × `total` (`:883`). Each clone gets a
   **fresh** `flowId`, `sessionId`, `requestId` (all `generateRequestId()`),
   `parentFlowId = parent.flowId`, `flowContext.contextNumber = index`, inheriting the
   parent's `rootFlowContext` / `rootAgentContext` / `chatContext` unchanged (`:1225`).
   `chatContext` stays identical across all clones so every history row groups under the
   originating chat.
2. Register each; attach the id array to `node.parallelContextTask` (`:890`).
3. Drain in **sequential batches of `chat.contextBatchSize ?? CONTEXT_BATCH_SIZE`** (default 15;
   per instance via `ChatAPIOptions.contextBatchSize`, `index.ts:79`–`82`) — fire a batch, wait
   for all of it, next batch (`:901`–`918`). 15 < the engine's ~33 admission slots so a single fan-out won't
   self-reject; a 10 k-context collection never floods the engine. Logs
   `[parallelContext] N/total contexts ready` per batch.
4. `maybeMarkParallelHostReady` (`:924`), then push the parent's continuation (`:926`–`938`).

> `contextNumber` lives on `flowContext` (`:1251`), not on `options`. Some comments/docs
> loosely say "options.contextNumber / options.context" — the authoritative location is
> `flowContext.contextNumber`.

> **⚠️ Note — batching is inconsistent across paths.** Only `handleSpawnedContext`
> (envelope-carried parallelContext) batches at 15. The node-carried
> `normaliseParallelContextTask` (`:1091`) and **both** `parallelFlowTask` paths
> (`:804`, `:1071`) fire *all* children at once via `Promise.all` with no cap. A large
> fan-out arriving as `childFlows` or node-carried is not throttled the way the primary
> context path is. (`DECISIONS.md §3` notes a stale in-code comment saying "batches of 10";
> the real `BATCH` constant is **15**, `settings.ts:54`.)

### Fan-out diagram

```mermaid
flowchart TD
    A["parent bundle: host node fires"] --> B{"envelope.data shape?"}
    B -->|"childFlows[]"| C["handleSpawnedChildren\nregister + validate parentFlowId"]
    B -->|"parallelContextTask {flowTask,total}"| D["handleSpawnedContext\nclone template × total"]

    C --> E["node.parallelFlowTask = child keys"]
    D --> F["node.parallelContextTask = clone keys"]

    E --> G["drainBundle(child) ×N — Promise.all (no cap)"]
    F --> H["drain clones in batches of 15\n(CONTEXT_BATCH_SIZE)"]

    G --> I{"all children completed?"}
    H --> I
    I -->|no| J["host node stays pending;\nouter loop revisits"]
    I -->|yes| K["maybeMarkParallelHostReady → node.ready"]
    K --> L["push parent's continuation nodeTasks\n(dedup vs pending)"]
    L --> M["parent drain resumes"]
```

### 5.3 Lazy allocation

The client only *registers* bundles and drains — it never pre-creates engine state. The
engine write-opens dict/session at the **first** node that does work (the start node), not
at spawn **[D§6]**. So a `dict not found` on a **non**-start node means the dict was
*deleted* (cancel / clone-merge / TTL), never "not yet written". Don't add a "warm the dict"
call.

---

## 6. Tool dispatch & virtual nodes

the engine fans out a `<SYSTEM CALL>` to a tool as a **spawned childFlow** (the
`isSpawnedChildrenResponse` path, §5.1) with `flowTask.toolFlow = true`. Two flavors ride
the same shape:

| Tool flavor | childFlow shape | Routed to | flow engine auto-propagates `options`? | Client injects virtual chain? |
|---|---|---|---|---|
| **flow tool** | a normal flow bundle (start → middle → end) | the flow engine | **yes** (caches `flowTask.options`, injects into each inner node) | no — real nodes already chain |
| **script tool** | ONE node, `kind === 'virtualScriptNode'` | **the script engine directly** (bypasses the flow engine) | **no** | **yes** (§ below) |

### 6.1 The `options` injection rule **[D§11]**

In the `NodeTaskRequest` builder (`task-queue.ts:480`–`489`), `options` is set by two rules
in priority order: (1) explicit `node.options` wins; (2) otherwise, for **any** nodeTask in a
`toolFlow:true` bundle, seed from `flow.options` — **regardless of `initial`**. The old
`initial === true` gate fit flow tools but broke script tools: a script-tool childFlow's only
node is `initial:false` and routes direct to the script engine, so the client SDK is the only
place that can carry the `toolContext` onto the wire. Don't bring back the `initial` gate.

### 6.2 The virtual chain (client-only, zero-wire) **[D§12]**

For a script-tool childFlow, the visualizer would otherwise show a lone card. The client
restores symmetry with two synthetic, `ready:true` nodes that **never travel on the wire**:

- **`virtualStartNode`** prepended in `normaliseInboundBundle` (`task-queue.ts:1397`–`1412`)
  when `flowTask.toolFlow === true && nodeTasks[0].nodeContext.kind === 'virtualScriptNode'`.
  Id `vStart-<uuid>`, `initial:false`, `flowContext` copied from the virtualScriptNode, a
  synthetic `{ success:true, code:'E1001', message:'OK' }` response.
- **`virtualEndNode`** appended in `runRegularNode` (`:594`–`602`) when the `{ final:true }`
  terminator fires **and** the firing node's `kind === 'virtualScriptNode'`. Id `vEnd-<uuid>`.

> The legacy `NodeTask.pendingAgentRedispatch` sidecar is **gone** — confirmed absent from the
> agent-runner `chat.d.ts`. Both tool flavors use the unified `childFlow + parent's
> continuation` pattern; the agentNode-redispatch arrives on the same envelope
> (`{ childFlows:[…], nodeTasks:[agentNode redispatch] }`) with
> `options: { toolResponse:true, promptMarker }` so the engine sources the new prompt from
> the tool's response. Do not reintroduce the sidecar.

---

## 7. Identity & keys

### 7.1 The bundle key

Every bundle is stored under `bundleKey(flowContext)` =
`` `${correlationId}_${sessionId}_${flowId}` `` (`task-queue.ts:20`). All three ids together,
so one flow tree holds root + parallel siblings + context clones without `flowId` collisions.

### 7.2 The id families

| Id | Origin | Shape | Role |
|---|---|---|---|
| **cid / correlationId** | the Keen server's `welcome` (`connect.ts:255`), or dev fallback (`:94`) | a bare UUID v4 minted by the relay (`relay.gateway.ts:117`) / `r-<uuid>` (fallback) | connection-scoped; the whole tree shares it; cancel key |
| **flowContext.sessionId** | `generateRequestId()` at init / per clone | `r-<uuid>` | session-storage scope; siblings share the parent's via `parentSessionId` **[D§5]** |
| **flowContext.flowId** | engine (root), `generateRequestId()` (clones) | `r-<uuid>` | dict scope + bundle-key component |
| **flowContext.requestId** | `generateRequestId()` at init / per clone | `r-<uuid>` | the **flow-tree** requestId; part of `rootFlowContext` + the endNode 4-id integrity check |
| **frame requestId** | `SendRequest.execute` (`send-request.ts:81`) | `r-<uuid>` | `waitFor` match key (`response.ts:52`); the engine's ProcessCoordinator dedup key |

> **⚠️ Two distinct requestIds.** The `requestId` inside `payload.flowContext` (flow
> identity) is **not** the `data.requestId` on the frame envelope (waitFor / dedup). Both are
> `r-<uuid>`. `ResponseAPI` keys on the **frame** one; it is minted once per `execute()` and
> reused across that call's transport retries, but a **response-level** retry
> (`runRegularNode` re-calling `sendNodeTask`) mints a *new* frame requestId per attempt.

### 7.3 Why global uniqueness — the headline fix **[D§4]**

`generateRequestId()` = `` `r-${generateUUID()}` `` (`utils.ts:41`). The engine's
`ProcessCoordinator` dedups in-flight work by **requestId alone, process-global** — not
per-cid (`utils.ts:28`–`40`). The old per-tab `r-<base36 time>-<seq>` counter minted
identical ids across tabs running in lockstep; the engine rejected the collision as a
spurious **E2003 "Duplicate requestId"** (non-retryable), so the TaskQueue catch fired
`sendCancel()` → `deleteByCid` wiped every dict for the cid → sibling clones cascaded into
**E6002 "flow cancelled or stale"**. A 10-tab load test failed ~3/10 this way; the fix made
all client ids globally unique through this one chokepoint (10/10 clean after). The **hard
law: any id the engine treats as globally unique must be globally unique on the client** —
never reintroduce a counter.

> **⚠️ Note — the *mechanism* differs from `DECISIONS.md §4`.** That doc (and DRIVE-LOOP §5)
> say `generateRequestId()` returns `` `r-${crypto.randomUUID()}` ``. The **agent-runner
> code does NOT use `crypto.randomUUID`** — it hand-rolls an RFC-4122 v4 from
> `crypto.getRandomValues` (`utils.ts:15`–`26`), *deliberately*, because `randomUUID` is
> secure-context-only and is `undefined` on a plain-http dev origin (`utils.ts:4`–`7`). The
> entanglement `HOW_TO_USE.md` agrees with the code (`generateUUID()`, not `randomUUID`).
> The *outcome* (globally-unique v4) and the reasoning in §4 are correct; only the named API
> is stale. Code is authoritative.

### 7.4 Integrity checks (client-side)

The endNode **4-id match** (`isEndOfFlowSignal`, `:950`) and the spawned-children
**`parentFlowId` match** (`:784`). The Keen server's *per-frame* cid anti-spoof (rejecting a `run`
whose cid doesn't match the socket) is **server-side** and not in these SDK files.

> **Visualizer selection key is `(nodeId, requestId)`, not nodeId alone [D§13]** — the same
> `nodeId` legitimately recurs (agentNode redispatch after a tool; a loop body re-entering).
> Each invocation is a fresh NodeTask with its own `flowContext.requestId`, so the harness
> keys selection on the composite. (Harness concern, but it explains why `nodeTasks` holds
> repeated ids.)

---

## 8. Retries & status codes

### 8.1 Two layers of retry **[D§10]**

| Layer | Where | Fires on | Policy |
|---|---|---|---|
| **Transport** | `SendRequest.execute` (`send-request.ts:80`) | socket not OPEN (frame couldn't be queued) | linear 1 s; `maxRetries` 10 for initial, `Infinity` for continuations; returns `{ ok:false }` on exhaustion (`ChatAPI.send`/`sendNodeTask` turn that into a throw, `index.ts:199`–`201`). Its ONE throw of its own: a frame over `MAX_FRAME_BYTES` (8 MiB, `settings.ts:73`) throws `FatalSendError` up front (`send-request.ts:99`–`105`) — non-retryable, re-thrown by the response loop (`task-queue.ts:546`–`548`) so the run aborts instead of retrying forever |
| **Response** | `runRegularNode` loop (`task-queue.ts:508`) | transient non-success envelope, OR `send`/`waitFor` threw (timeout, drop) | sleep 1 s, re-issue whole send+wait; 10 for `initial`, `Infinity` otherwise |

`send` + `waitFor` share one try (`:524`–`558`) so a `waitFor` timeout on a continuation
feeds the *response* retry loop instead of escaping and killing an otherwise-recoverable flow
(`:515`–`522`). `maxResponseRetries` is chosen by `node.nodeContext.initial` (`:504`, `:526`):
a failed *start* means the user's request never began (bound it at 10); a continuation's flow
is already alive server-side (retry forever until the socket recovers). Don't merge the loops.

### 8.2 The status-code contract

The client classifies by **E-prefix**. `isTerminalErrorCode` (`task-queue.ts:701`):
**`E2*`, `E3*`, `E8*` are terminal (throw); everything else is retried.**

| Prefix | Group | Client treatment | Example (source) |
|---|---|---|---|
| `E1xxx` | success | `envelope.success === true` path | `E1001` "OK" (`task-queue.ts:1404`) |
| `E2xxx` | client error (bad payload) | **terminal** — throw | `E2003` "Duplicate requestId" (`utils.ts:35`); `E2001` missing context (engine) |
| `E3xxx` | auth failure | **terminal** — throw | `E3002` "Invalid token" (`index.ts:112`); `E3101` space not allowed (`chat.d.ts:82`) |
| `E4xxx` | capacity / admission | **retried** | `E4001` admission reject (engine's ~33-slot gate; `settings.ts:52`) |
| `E5xxx` | resource | **retried** | `E5001` not-found (engine) |
| `E6xxx` | system | **retried** | `E6002` "flow cancelled or stale" (`utils.ts:36`); `E6101` |
| `E7xxx` | upstream | **retried** | upstream failures |
| `E8xxx` | explicit cancellation | **terminal** — throw | intentional termination |

A non-retryable code throws `envelope.message ?? envelope.code` (`:679`–`681`), hits the
failure boundary, fires `sendCancel`, propagates out of `run()`. The classic cascade: **E2003
→** run throws → `sendCancel(cid)` → engine wipes the cid → sibling clones report **E6002**.

> **The client's classification is deliberately broader than the wire's `E4*`-only
> retryability** (`DRIVE-LOOP §6`): the Keen `Status.isRetryable` convention is `E4*` only,
> but the client retries E4/E5/E6/E7 and treats only E2/E3/E8 as terminal — because a
> continuation's flow is already alive server-side, so it keeps trying through transient
> E6/E7. Only `E1001` and the prefix rule are literally in the SDK files; the named codes
> `E4001`/`E5001`/`E6101` come from the broader engine/server contract.

---

## 9. Cancel & teardown

### 9.1 Consumer cancel

`ChatAPI.cancel()` (`index.ts:275`) → `TaskQueue.cancel()` (`task-queue.ts:235`):

```ts
this.cancelled = true;
if (this.rootCorrelationId) this.chat.sendCancel(this.rootCorrelationId);
this.clear();
```

- `cancelled = true` — every `await` boundary in the drain machinery checks it and bails
  (`processNode` `:347`, `runRegularNode` `:511`/`:529`/`:560`, `drainBundle` `:310`, the
  batch loops). This is the **tail-bail** that stops post-cancel continuations.
- `sendCancel(rootCorrelationId)` → `{ event:'cancel', data:{ correlationId } }`
  (`index.ts:304`). The Keen server forwards it; the engine `deleteByCid`s **dict, session,
  agent-state, and the work queue** for the cid. One signal covers the whole tree because
  every bundle shares the cid.
- `clear()` empties the map and `emitUpdate()`s an empty snapshot.

Cancel is **blunt** — it wipes *all* state for the cid, and `run()` fires it on *any* fatal
node error, so keep terminal-classification tight **[D§8]**.

### 9.2 The in-flight `runFlow` promise

When `cancel()` fires mid-run, the drain machinery throws `'TaskQueue cancelled'` at its next
flag check (`:170`/`:211`). That hits the failure boundary (`:216`) — but because
`this.cancelled` is `true`, the boundary **skips** the second `sendCancel` (`:217`) and just
`clear()`s + re-throws. So `runFlow()` **rejects** with `'TaskQueue cancelled'`; treat that
rejection as "cancelled", not an error. Late responses arriving after cancel land in
`ResponseAPI` but find no pending `waitFor` → silently dropped.

> `SendRequest.cancel()` (`send-request.ts:144`) exists but TaskQueue never calls it —
> cancellation propagates purely through the `cancelled` flag + the thrown error.

### 9.3 The failure-path cancel

Any *non-cancel* throw in `run()` also fires `sendCancel()` (no arg → connection cid via
`getCorrelationID()`, `index.ts:305`) so partial engine state is wiped even when the user
didn't cancel (`:216`–`222`).

> **⚠️ Note — cancel before the root bundle arrives sends no cancel frame.**
> `rootCorrelationId` is set only *after* the root bundle is received (`:194`). If you
> `cancel()` between the initial send and the root reply, `cancel()` sends nothing (its
> `rootCorrelationId` is null) and the failure boundary skips `sendCancel` because
> `cancelled` is already `true`. Engine state for that cid then relies on the 60 s TTL — or
> on `disconnect()`, whose server-side `handleDisconnect` fires `dispatcher.cancel(cid)`
> (HOW_TO_USE Step 7) as a backstop.

---

## 10. Heartbeat

`startHeartbeat` (`task-queue.ts:1279`) arms a `setInterval` firing `chat.sendPing()` every
`HEARTBEAT_INTERVAL_MS`. `sendPing` (`index.ts:326`) sends `{ event:'ping', data:{} }` — no
payload; the Keen server derives the cid from the socket → the engine
refreshes dict/session (and agentState) TTLs.

- **Value: 5 000 ms** (`settings.ts:47`). Against the engine's **60 s** dict/session TTL
  that's a ~12× margin, so a live flow never hits the TTL while abandoned/finished state
  reclaims within ~a minute. Because there is **no explicit delete on clean completion** for
  the root flow (the whole tree shares one `root.flowId` dict; only the client knows when the
  entire tree settled), the TTL *is* the reclaim path — which is why the 5 s heartbeat and
  the 60 s value are paired (`DRIVE-LOOP §7`).
- **Starts** right after the cid is resolved (`:112`); **stops** in the outer `finally`
  (`:225`) — success, throw, and cancel. `stopHeartbeat` (`:1293`) is idempotent;
  `startHeartbeat` no-ops if a timer is live.

> **⚠️ Note — the cadence is 5 s, not ~20 s.** `index.ts:321` and the entanglement
> `HOW_TO_USE.md` Step 5 both say "every ~20s" — **stale**. `DRIVE-LOOP §7` and
> `settings.ts:47` (the single source of truth, `CHAT_SETTINGS.HEARTBEAT_INTERVAL_MS`) are
> the correct 5 s. Code is authoritative.

---

## 11. What to expect on `onStream`

`ResponseAPI.handle` routes any inbound frame **without** an `envelope` to the stream
handlers (`response.ts:72`–`74`): `handler(frame.event, frame.data, requestId)`. The
`StreamEventHandler` signature (`chat.d.ts:500`) is `(event, data, requestId?)`. Subscribe via
`chat.onStream(...)` (`index.ts:347`).

| Field | Type | Meaning |
|---|---|---|
| `event` | string | the stream kind — `chat.d.ts:24`/`:500` name `thinking`, `processing`, `progress`, `token`, `error` (exactly the five the engines' `emitterMgr` publishes) |
| `data` | `InboundFrame['data']` | the raw frame body `{ text?, data? }` (engine `emitterMgr` → relay `OutboundStream`); **no** `envelope`, **no** `requestId` |
| `requestId?` | string | **always absent** on stream frames — the relay's `OutboundStream` carries no requestId (the cid is per-connection; `relay.gateway.ts:371`–`376`) |

**How they differ from envelope frames:** a `run` reply carries `data.envelope` and resolves
the pending `waitFor(requestId)` (the node's *result*). A stream frame carries no envelope —
running commentary (token text, phase changes) that never resolves a `waitFor` and never
advances the drain loop. Both travel over the same socket; envelope presence is the only
discriminator.

**Common `data` payloads:**

- **Token text** — `event:'token'`, `data.text` is the incremental LLM output; concatenate
  for live typing.
- **`<SYSTEM CALL>…</SYSTEM CALL>` directives** — arrive **inline inside the token text**, not
  as a distinct stream event. They are the orchestrator's tool-call directives the LLM wrote
  into its own output; a client parses them out of the concatenated stream (a *view* of what
  the model wrote, not an engine routing event). The actual tool dispatch surfaces to
  TaskQueue as a `childFlows` **envelope** response (§6), not as a stream frame.
- **Phase markers** — `thinking` / `processing` / `progress` for UI state.
- **`error`** — an engine progress-level note; the authoritative failure still comes as a
  non-success **envelope** the drain loop acts on.

> TaskQueue itself does **not** subscribe to `onStream` — streams are for the UI layer; the
> queue advances only on envelope responses.

---

## 12. Consumer quick-start

Minimum end-to-end (from the SDK's `HOW_TO_USE`). Everything below the facade is internal —
you import only `ChatAPI`.

```ts
import ChatAPI from './sdk';

const chat = new ChatAPI({
    spaceID:     'test-space',
    agentID:     'agent-one',
    userId:      '<consumer-id>',               // MUST equal the access_token's `sub`
    email:       'consumer@example.com',
    accessToken: '<real consumer JWT>'          // verified per message; not a dev no-op
    // url    → defaults to CHAT_SETTINGS.WS_URL
    // projectID → defaults to spaceID (space id === project id)
});

chat.onStatus(s => {/* 'connecting' → 'connected' */});
chat.onStream((event, data) => {/* render tokens/progress */});

chat.connect();
const cid = await chat.whenReady();                // gate the first run on the welcome

const bundles = await chat.runFlow({ chatId: 'chat-abc-123', prompt: 'hello' });
chat.disconnect();
```

- `chatId` is the **only required** `runFlow` field; `userId`/`email`/`projectId`/`agentId`
  default to the ctor and are per-call overridable. `space` and `accessToken` are **not**
  overridable per call.
- The returned map is keyed `${cid}_${sessionId}_${flowId}` and is mostly for
  inspection/debugging — the user-facing output flows through `onStream` during the run.
- Multi-turn: call `runFlow` again with the **same `chatId`** (the engine groups turns by it);
  a fresh `sessionId`/`requestId` is minted per turn internally.
- Send-button gate: `disabled = !(status === 'connected') || running` — wire `onStatus` +
  `onRunning`.
- The SDK does **no** auto-reconnect, no token minting, no cookie management beyond the
  initial-run forward of `ChatAPIOptions.cookies` (a name allow-list read from `document.cookie`,
  or an explicit map for headless callers), and no message persistence (pending `waitFor` reject
  on `disconnect()`).

---

## 13. Constants reference

`settings.ts` (`CHAT_SETTINGS`); per instance only `url` and `contextBatchSize` are overridable via `ChatAPIOptions` (`index.ts:79`–`86`):

| Constant | Value | Used by |
|---|---|---|
| `WS_URL` | `'ws://localhost/ws-keen'` (`settings.ts:27`) | the SDK's dev-literal default; a deployment always passes `url` = `wss://<keen-host>/ws-keen` (a host the *browser* can reach) |
| `RESPONSE_TIMEOUT_MS` | `600_000` (10 min) | `ResponseAPI.waitFor` timeout — long so a debug pause never trips a retry |
| `RETRY_DELAY_MS` | `1_000` | both retry layers' backoff (linear, not exponential) |
| `HEARTBEAT_INTERVAL_MS` | `5_000` | ping cadence while running |
| `CONTEXT_BATCH_SIZE` | `15` | default max parallelContext clones in flight (envelope-carried path; per-instance `ChatAPIOptions.contextBatchSize`); < engine's ~33 admission slots |
| `INITIAL_MAX_RETRIES` | `10` | bounded retries for initial-run frames + initial nodes |
| `MAX_FRAME_BYTES` | `8 * 1024 * 1024` | `SendRequest.execute` pre-check — an oversized outbound frame throws a non-retryable `FatalSendError` instead of retrying forever (mirrors the server's NATS max_payload) |

---

## 14. Divergences from the existing docs

Where an existing doc or in-code comment disagrees with the **agent-runner/sdk/ code**. Code
is authoritative in every case.

1. **`generateRequestId` uses `getRandomValues`, not `crypto.randomUUID`.**
   `DECISIONS.md §4` and `DRIVE-LOOP §5.2` name `crypto.randomUUID`; the code hand-rolls a v4
   from `crypto.getRandomValues` (`utils.ts:15`) precisely because `randomUUID` is
   secure-context-only and throws on plain-http dev. The entanglement `HOW_TO_USE.md` agrees
   with the code. The *fix's intent* (globally-unique v4) is correct; only the named API is
   stale. (§7.3)

2. **The endNode terminator matches four ids, not three.** `DRIVE-LOOP §4` says "the three
   ids must match"; `isEndOfFlowSignal` checks `flowId` **and** `correlationId`,
   `sessionId`, `requestId` (`task-queue.ts:969`). (§3.9)

3. **Heartbeat is 5 s, not ~20 s.** `index.ts:321` and entanglement `HOW_TO_USE.md` Step 5
   say ~20 s; `settings.ts:47` and `DRIVE-LOOP §7` are the correct 5 s. (§10)

4. **`accessToken` is re-stamped on *every* frame.** The `connect.ts:47`–`57` /
   `index.ts:118`–`129` / `chat.d.ts:224`–`232` comments describe a design where a
   server-derived `correlationToken` *replaces* the access_token after the initial run. The
   running code always re-stamps `accessToken` (`task-queue.ts:454`, `:1233`) and forwards
   `correlationToken` only when present (`:444`). The DRIVE-LOOP / HOW_TO_USE prose is
   consistent with the code; the type/connect comments are aspirational. (§3.1)

Deliberate design (not divergences), documented in `DECISIONS.md`, that a first reader often
mistakes for oddities: the dev-only cid fallback **[D§7]**; the dormant
`ContextRunPayload`/`sendContextRun` path **[D§3]**; the client's retry classification being
broader than the wire's `E4*`-only contract (§8); dedup against pending-only **[D§2]**;
cancel being a blunt whole-tree wipe **[D§8]**; the `toolFlow` options rule ignoring `initial`
**[D§11]**; and the visualizer-only virtual nodes **[D§12]**.

Genuine code-level observations still worth a flag: fan-out batching is inconsistent across
the two context/child paths (§5.2); `NodeTask.nextNodes` is declared but unused (§4.4);
`SendRequest.cancel()` is never called by TaskQueue (§9.2); cancel before the root bundle
sends no cancel frame (§9.3, backstopped by `disconnect()`).
