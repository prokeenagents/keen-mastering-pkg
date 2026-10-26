# The data model — dictionary, session, agent-state (and the `${...}` rules)

Everything a flow "remembers" lives in a few per-run stores. Get these straight and most flow bugs
disappear. **Every fact here is verified against the Keen engine**; file citations are given where a
claim is subtle.

---

## The three stores you actually author against

| Store | Scope | Shape | Read in a field with | Cap · TTL |
|---|---|---|---|---|
| **`dictionary`** | **per-flow** working scratchpad | **nested JSON** (objects, arrays, primitives) | `${dictionary.a.b}` (nested) | 1.5 MB · 60 s |
| **`session`** | **whole-run**, shared by every flow in the run | **flat** KV of **primitives only** | `${session.key}` (flat) | 1.5 MB · 60 s |
| **`agent-state`** | per-run conversation (prompts + responses) | `{ agentId: { channel: [newest…] } }` | *not* a `${…}` field — only `system/agent` in scripts / the Agent node | 8 MB/entry, 200/lane · 60 s |

Plus three **auxiliary** stores placeholders cannot reach: **treeContext** (run identity — **engine-only**,
not script-readable either), **cookieStorage** (request cookies) and **agent-settings** (the agent's Json
Settings) — the last two are readable from scripts. See the bottom.

---

## The `${...}` placeholder system (the shared contract)

Wherever a node field is **interpolated**, the exact same resolver runs (`evaluateValue`) — identically
everywhere `${…}` is interpolated. The rules are strict:

- **Only two roots exist: `${dictionary.…}` and `${session.…}`.** The regex is literally
  `/\$\{(dictionary|session)\.([^}]+)\}/g`. There is **no** `${agent.*}`, `${input.*}`, `${env.*}`,
  `${settings.*}`, `${document.*}`, or channel placeholder — any other root resolves to nothing.
- **`${dictionary.a.b.c}` is a nested dot-walk** of plain objects. **No array indexing** —
  `${dictionary.list[0]}` and `${dictionary.list.0}` do **not** work (they resolve to nothing). Bare
  **`${dictionary}`** (no dot) is not recognized either.
- **`${session.key}` is flat** — the whole path is one literal key. `${session.a.b}` looks up the single
  key `"a.b"`; it does **not** nest.
- **Type behaviour:**
  - A field whose value is **exactly one** placeholder (`"${dictionary.count}"`) returns the resolved
    value **with its type preserved** (number stays a number, array stays an array).
  - A field that **mixes** text and placeholders (`"Hi ${dictionary.name}"`) returns a **string** —
    primitives are `String()`-joined, a non-primitive slots in as empty string.
  - A **plain literal with no placeholder is returned as typed on the canvas — i.e. a *string*.** Typing
    `1` stores `"1"`, **not** the number `1`. There is no numeric/boolean coercion.
- **`${Array([...])}` operator** — builds a real array (only where a field allows arrays). The inside is
  a list of literals; string elements may themselves contain `${dictionary.*}`/`${session.*}`. Any
  non-primitive element collapses the whole thing to `[]`.
- **No default/fallback syntax, no escaping.** A missing `${dictionary.x}` becomes empty string (in
  text) / `null` (single-placeholder) / the literal `null` (in a condition).

### Where `${...}` applies — the per-field cheat-sheet

| Node · field | `${…}` interpolated? | Notes |
|---|---|---|
| **Start** · Label | ❌ static identifier | it's the entry name; the form even forbids `$ { } .` |
| **End** · terminate-dictionary | ❌ literal boolean | — |
| **Condition** · expression | ✅ **condition-style** | `${dictionary.x}`/`${session.x}` substituted → jsep evaluates. Bare `dictionary.x` **throws**. |
| **Assignment** · pair **value** | ✅ value interpolation | types string/number/boolean/array; object → `null` |
| **Assignment** · pair **key** | ❌ literal | flat top-level property name (`dict[key]`) |
| **Loop** · Read from / Set to | ❌ **path reference** | must be `dictionary.<path>` or `session.<key>` (optional `${}` wrapper); a bare name **throws**. Read from belongs in the dictionary — a session value is never an array, so a `session.` source finishes at once |
| **Run Flow / Jump Flow** · Flow | ✅ interpolated (string) | engine-side a target could be dynamic (`${dictionary.which}`), but the form and `keen-validate` accept only a literal letters-only `File-Label` |
| **Parallel Flows** · Flow Pointer target | ✅ interpolated (string) | the entry name — same literal-only form rule as Run / Jump |
| **Parallel Context** · contextCollection | ❌ **dictionary reference** | the form requires the literal `dictionary.<path>` prefix (the engine also tolerates a `${dictionary.<path>}` wrapper) |
| **Parallel Context** · pipe (template flow) | ❌ **static string** | not interpolated |
| **Agent** · agentName / agentId / sessionId / requestId / each prompt **content** | ✅ interpolated | only these |
| **Agent** · model / params / specialRules / agentResponse / agentResponseProperty | ❌ literal | — |
| **Script** · prop (key/value) **values** | ✅ interpolated | delivered to `exec(props)` |
| **Script** · script file name | ❌ literal | it's a filename |
| **Join / Note** | — | no fields |

> **Two mechanisms, don't confuse them.** *Value interpolation* (Assignment/Agent/Script) substitutes a
> `${…}` into a value. *Condition* substitutes `${…}` then evaluates the whole thing as a **jsep
> expression** (so you write `${dictionary.x} > 25`, and bare identifiers/member-access throw). *Loop*,
> *Parallel Context collection* are **references** — they name a store slot (`dictionary.foo`), they are
> not value-interpolation.

---

## `dictionary` — the per-flow scratchpad

- **What it is:** a mutable **nested JSON** object, private to a flow. Arbitrary shape (objects, arrays,
  primitives) as long as it's JSON-serializable.
- **Where it lives:** the platform's fast store, per-flow. **Cap 1.5 MB, TTL 60 s** (refreshed on every
  open/commit and by the client heartbeat, so a live flow never expires).
- **Seeded:** **empty `{}`** at a flow's start. (Exception: a **Parallel Context** clone's dict is seeded
  from its slice of the collection; a **Parallel Flows** sibling's dict starts empty.)
- **Who reads it:** `${dictionary.path}` in any interpolated field; a **Script** node via the bare
  `dictionary` global (writable copy) or `system/dictionary.get({flowID, path})` (cross-flow, read-only).
- **Who writes it:** **Assignment** (`dictionary[key]=…`), **Loop** (`Set to`), **Agent** (opt-in
  `agentResponse`), a **Script** (mutating its `dictionary` global, committed on clean return).
- **Whose dictionary? — three modes** (this is the thing to understand about composition):
  - **shared** — the root flow, and **Run Flow / Jump Flow** children, and tool flows, all read/write the
    **same (inherited) dict**. This is why a Run Flow child can hand a value back to its caller.
  - **isolated** — a **Parallel Flows** sibling gets its **own empty** dict, discarded at its end; nothing
    merges back.
  - **clone** — a **Parallel Context** child gets its own dict (seeded from one collection element),
    **merged back** into that element when it finishes.

## `session` — the whole-run shared store

- **What it is:** a **flat key/value map of primitives** — values may only be **string, finite number,
  boolean, or null**. Objects, arrays, functions, `NaN`/`Infinity` are **rejected** (a write throws).
- **Where it lives:** the platform's fast store, whole-run. **Cap 1.5 MB, TTL 60 s.**
- **Shared across the *entire run*** — every flow, every Run/Jump child, every parallel branch sees the
  same session: Scripts and flow nodes always open the run's root session. Use it for values that must be
  visible everywhere in the run; use the **dictionary** for per-flow working data.
  - **One exception — an Agent node inside a Parallel Context clone.** An Agent node resolves its
    `${session.*}` placeholders against its flow's *parent* session id, or its own session id when there is
    none. A Parallel Context clone has its own fresh session and no parent session id, so there (and in any
    flow spawned from a clone) `${session.*}` in an Agent field comes back **empty**. Put
    such values in the clone's dictionary instead (see `business-objects.md`).
- **Seeded EMPTY.** ⚠️ **Correction to a common assumption:** the session is **not** pre-filled with
  `sessionID` / `requestID` / `userID` / `userEmail`. Those are **not** in the session at runtime — run
  identity lives in **treeContext** (below). So `${session.userEmail}` is **empty** unless a node
  explicitly wrote a `userEmail` key. Don't rely on session identity keys that nothing set.
- **Who reads it:** `${session.key}` (flat) in interpolated fields; a **Script** via `system/session`.
- **Who writes it:** a **Loop** whose `Set to` targets `session.<key>` (primitive elements only — an
  object or array element is rejected); a **Script** via `system/session` (`setSessionValue` / direct
  property). (No flow node other than Loop writes the session.)

## `agent-state` — the conversation (the "third thing")

- **What it is:** the running conversation for the chat — **two** documents per run: a **prompts** store
  (user/trigger prompts) and a **responses** store (agent responses). Each is `{ agentId: { channel:
  [newest first, …] } }`. The default **channel** is `'root'`; channels let you run parallel sub-conversations.
- **Caps:** 8 MB per entry, 200 entries per channel-lane, TTL 60 s.
- **Seeded:** at run start the user's message is written to the **prompts** store under the agent + `'root'`
  with `role:'user', agentChat:true` — that's the trigger an **Agent** node picks up.
- **Who touches it:** the **Agent** node (reads its trigger from the **prompts** store; always mirrors its
  answer to the **responses** store on the trigger's channel) and a **Script** node via **`system/agent`** (19 methods:
  `getRootAgentPrompt`, `getAgentLastResponse`, `getChannelResponses`, `setAgentResponse`,
  `deleteChannel`, …). **It is *not* reachable from `${…}` placeholders** — only via those APIs.

---

## Auxiliary stores (placeholders cannot reach them; only two are script-readable)

| Store | Where | Holds | Read via | Write? |
|---|---|---|---|---|
| **treeContext** | run-identity store (engine-internal) | run identity: `userId, email, agentId, chatId, projectId, rootFlowId, rootSessionId, rootRequestId` | **engine-internal only** — no `${…}` root and no `system/*` resource exposes it. A Script sees just the per-call `flowContext` global (`correlationId` / `sessionId` / `requestId` / `flowId` / `parentFlowId` …) and, inside a tool flow, `toolOptions.toolContext.agentId` | engine only |
| **cookieStorage** | per-run cookie store | request browser cookies `{ name: value }` (e.g. an OAuth token) | Script `system/cookies` (`get`/`all`/`has`) | read-only |
| **agent-settings** | the agent's settings cache | the agent's **Json Settings** fields | Script `system/settings` (`get`/`getMany`/`has`) | read-only |

> So **identity** (who the user is, which agent/chat) is in **treeContext**, and treeContext is
> **engine-internal** — it is reachable **neither** from `${session.*}` **nor** from a script. If a flow
> needs `userEmail` (or any user identity), it has to **arrive from the client** — in the prompt, or as
> Script props — and a node can then copy it into the dictionary/session for later placeholders.

---

## Lifetime & cleanup (all stores)

All per-run stores carry a **60 s TTL**, refreshed by the client heartbeat while a flow is live — so an
active run never expires, and finished/abandoned state reclaims about a minute after the last beat. Under
load the engines gate **admission by memory, never by evicting live state**: any node dispatch may be
refused with a retryable `E4001` while an instance is near its memory budget, and the platform retries it
transparently (see `best-practices.md`) — no running task ever loses its working data. On a clean
end-of-root-flow (or a cancel) the engine also wipes the dictionary, session, agent-state,
treeContext and cookies for that run. **Nothing here is durable** — it's the working memory of **one
run**, not a database.

---

*See each node's page in `nodes/` for exactly which of its fields read or write which store.*
