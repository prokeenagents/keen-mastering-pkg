# ChatSDK — API reference

The self-contained Keen chat client under [`../sdk/`](../sdk/) (zero project imports). Drive a flow, stream its progress, read the flow-tree, cancel it. `run.ts` is one thin consumer of this; build your own the same way.

```ts
import ChatAPI from './sdk/index';        // default export
import { CHAT_SETTINGS } from './sdk/settings';
```

In Node, provide the browser `WebSocket` global before constructing (the SDK calls `new WebSocket(url)`):

```ts
import { WebSocket } from 'ws';
(globalThis as any).WebSocket = WebSocket;  // add { origin } if the Keen server allow-lists origins
```

## Construct

```ts
const chat = new ChatAPI({
  url?: string,          // the Keen server WS — always pass wss://<host>/ws-keen; the default
                         // CHAT_SETTINGS.WS_URL is the dev literal 'ws://localhost/ws-keen'
  spaceID: string,
  agentID: string,       // the agent SLUG
  userId: string,        // must equal the token's (sealed) sub
  email: string,         // presence-checked by the Keen server
  projectID?: string,    // default: spaceID
  accessToken: string,   // consumer access_token
  cookies?: string[] | Record<string, string>,
                         // forwarded to script nodes on the initial run (system/cookies): a list of
                         // NAMES filters the browser's document.cookie; an explicit { name: value }
                         // MAP is used as-is with no browser (run.ts builds it from --cookie / KEEN_COOKIES)
  contextBatchSize?: number,
                         // parallelContext clones drained per wave; default CHAT_SETTINGS.CONTEXT_BATCH_SIZE (15)
  onAuthExpired?: () => Promise<string | null>,
                         // the token refresher (Keen 15.3): called once per `token` refusal of a
                         // resume, and once per node visit on an E3002 reply. A string becomes the access
                         // token (the resume / the node is re-sent at once); null ends the run with
                         // `Invalid token`. A throw is retried after the backoff. run.ts passes one that answers null (it cannot mint a token).
});
```

## Lifecycle (the canonical order)

```ts
chat.onStream((event, data, requestId) => { /* live progress */ });
chat.connect();                       // 1. open the WS (async handshake)
const cid = await chat.whenReady();   // 2. wait for the Keen server's welcome (assigns the connection cid)
const tree = await chat.runFlow({ chatId, prompt });  // 3. drive one flow → resolves with the flow-tree
// … read tree …
chat.disconnect();                    // 4. close (cancels a still-running flow first)
```

Skipping `whenReady()` before `runFlow()` is the classic bug: `TaskQueue` mints a fallback cid the Keen server rejects as *"correlationId does not match connection cid"*.

## Methods

### Connection
- **`connect(): void`** — open the WebSocket. No-op if already open (or a reconnect is scheduled). In a browser it also arms the `pagehide` cancel (below).
- **`disconnect(): void`** — **cancels a running flow first** (the Keen server no longer cancels on a close — it holds the flow for its grace so a dropped socket can resume — and a disposed `ChatAPI` can never resume), then closes the socket with 1000, stops reconnecting and disposes response handlers. Clears the cid.
- **`isConnected(): boolean`** — socket open?
- **`isReady(): boolean`** — socket open AND bound to the flow's cid: false between a reconnect's `welcome` and its `resumed`. Run / cancel / ping frames go out only then.
- **`getStatus(): ConnectStatus`** — `'disconnected' | 'connecting' | 'connected' | 'reconnecting'` (the type also declares `'unauthorized'`, never emitted). `'reconnecting'` lasts from a drop until the new socket is ready — the resume included. Drive a UI Send-gate with it.
- **`whenReady(): Promise<string>`** — resolves with the connection cid once the Keen server's `welcome` frame arrives (immediately, if already known). **It never settles if the socket closes before the welcome** (e.g. a silent origin drop) — always race it against a timeout, as `run.ts` does (15 s). **Gate `runFlow` on this.**
- **`getCorrelationID(): string | null`** — the connection cid, or null before welcome. While a dropped socket resumes a running flow it stays the flow's (old) cid.
- **`getPromptLimit(): number | null`** — the longest prompt, in characters, the Keen server accepts: `welcome.limits.promptChars` (**20000** today, one limit for the whole platform), or null until a welcome carried it (an older server sends none). Use it for a counter and to stop the send. A longer prompt is refused by the server with **`E2101`** (see *Prompt limit* below).
- **`setCorrelationID(cid): void`** — force a cid (only for a server that sends no welcome; normally untouched).

### Running
- **`runFlow(input: RunFlowInput): Promise<ReadonlyMap<string, FlowTaskBundle>>`** — drive ONE flow to completion. Resolves with the flow-tree (below). Rejects with the server/engine error (`Invalid token`, an `E….` code, `TaskQueue cancelled`, an oversized-frame `FatalSendError`, a `ConnectionLostError` — see *Reconnect and resume* —, …). The SDK does all orchestration (per-node sends, parallel fan-out, retries); the engine is a pure function.
  ```ts
  interface RunFlowInput { chatId: string; prompt: string; userId?; email?; projectId?; agentId?; }
  ```
- **`isRunning(): boolean`** — a run in flight?
- **`onRunning(handler): Unsubscribe`** — fires `true` when a run starts, `false` when it settles (success / throw / cancel). Pair with `onStatus`: `canSend = status === 'connected' && !running`.
- **`onSummarizing(handler: (active: boolean) => void): Unsubscribe`** — the chat is being compressed. Fires `true` when the SDK dispatches a node task of kind `summarizerNode` (the Summarizer node: the LLM node answered, the summary was due, and the flow now runs the Summarizer as its own step), `false` when that task settles — its reply, an error, a cancel, or the flow's end; it is never left at `true` (`runFlow`'s exit resets it). A Fallback chain of Summarizers gives `true, false, true, false`. The flow is still running meanwhile (`isRunning()` stays `true`, so Send stays off): show a line such as "Compressing the conversation…" under the last answer while it is `true`. The handler type is `type SummarizingHandler = (active: boolean) => void` in the `App.Chat` types (next to `RunningHandler`).

### Streaming & events (all return an `Unsubscribe`)
- **`onStream((event: string, data, requestId?) => void)`** — every engine → user progress frame (token text, `<SYSTEM CALL>` directives). The live view. **This is the "hook"** a headless runner turns into stdout.
- **`onStatus(handler)`** — connection status changes.
- **`onSystem(handler)`** — socket-level notes (open/close/error/parse failure) as plain strings.
- **`onWelcome(handler)`** — fires with `{ correlationID }` when a socket becomes ready on a NEW cid (not after a resume).
- **`onResume(handler)`** — fires with `{ correlationID, detachedMs }` when a dropped socket resumed the running flow on its old cid. The token stream emitted while the socket was away is **not** replayed: re-read the chat history when the resumed turn ends.

### Stopping (cancel)
- **`cancel(): void`** — THE consumer-facing cancel. Stops the local drain loop, sends the `cancel` frame for the run's cid (the Keen server wipes that cid's `dict` / `session` / `agentState` / queue, so a half-run leaves nothing behind) and clears local state; the pending `runFlow` promise rejects with `TaskQueue cancelled` **at once**. Safe to call when idle. While reconnecting the cancel is **deferred**: the next socket resumes the cid (that proves ownership) and then sends it; if the client never gets back, the Keen server's grace ends the flow.
  ```ts
  chat.cancel();                     // cancel the current run
  ```
- **`sendCancel(correlationID?: string): boolean`** — low-level: fires ONLY the cancel frame (defaults to the connection cid), no local cleanup. Returns `false` if the socket is not ready or no cid is known (a resumable cid then gets the cancel deferred to after the next `resumed`). Do **not** use it to stop a run from your own client — the drain loop keeps going, the wiped cid answers `E6002`, which the SDK classifies as retryable, and a continuation then retries forever. `run.ts` calls `cancel()` then `disconnect()` on `SIGINT` and exits `130` — so Ctrl+C really stops the flow on the engine, not just the client.

### Low-level (not needed by a runner)
- **`onResponse(handler)`** — every response envelope · **`waitFor(requestId)`** — the pending-reply promise · **`send()` / `sendNodeTask()` / `sendContextRun()`** — the raw frame senders `TaskQueue` uses; each takes `opts.requestId` (the node-visit id) and mints one only when none is given · **`sendMessage()`** — send + waitFor in one · **`getUrl()`**.

### Token refresh
- **`setAccessToken(accessToken: string): void`** — replace the bearer used inside every subsequent run/continuation frame WITHOUT tearing down the socket (the Keen server verifies it per-frame). Call it when a token is about to expire during a long session. The current connection/cid is preserved. Without `onAuthExpired`, a resume refused `token` waits for exactly this call (a CHANGED token) and then re-sends the resume.
- **`ChatAPIOptions.onAuthExpired`** — see *Construct*. It also serves an `E3002` reply on a node: refresh once, then retry the SAME visit id; a second `E3002`, or a null refresh, is terminal (`Invalid token`). Without the hook `E3002` stays terminal, as `E3101` always is.

### Heartbeat
Automatic. While a `runFlow` is in flight `TaskQueue` fires `chat.sendPing()` (`{ protocol: 2 }`) every `CHAT_SETTINGS.HEARTBEAT_INTERVAL_MS` (5 s) to refresh the engine-side TTLs (dict/session/agentState), and stops on settle. A protocol-2 Keen server answers each with a `pong`; 15 s with no inbound frame while a run is active closes the socket (4000) and reconnects. You do not call it yourself.

## Prompt limit (E2101)

The user's prompt is limited to **20 000 characters** (UTF-16 units, the same as a browser's `maxlength`), for every agent on the platform. The Keen server checks it on the run frame, before anything is dispatched or stored, and answers with an error frame (the flow fails with that error; no node runs):

| Code | Message | When |
|---|---|---|
| `E2101` | `The message is too long (at most 20000 characters).` | the prompt is longer than the limit |
| `E2101` | `The message must be text.` | the prompt is not a string |

The limit is announced in the `welcome` frame: `limits: { promptChars: 20000 }` (additive; older servers send no `limits`). The SDK keeps it and `getPromptLimit()` returns it, so a chat UI can show a counter and stop the send; the server's check is the rule. Only the user's prompt is limited, not the prompts a flow sets itself. `E2101` is a validation refusal, not a transient `E4` busy: the SDK does not retry it.

## Reconnect and resume (Keen 15.3)

A dropped socket never ends a started flow. The Keen server detaches the flow's cid for a grace (120 s by default) instead of cancelling it, and the SDK:

1. **Reconnects** after a close it did not ask for (not `disconnect()`, not 4409), once the instance has seen a welcome: the pause before attempt *n* is random in `[0, min(10 s, 1 s × 2^(n−1))]` — full jitter, caps 1 → 2 → 4 → 8 → 10 s, no attempt limit; a relay restart (1012) waits 0–1 s. A close before the first welcome stays `disconnected` (a bad URL or origin fails fast).
2. **Resumes**: if a flow runs on the old cid, it ran a frame, the SDK holds the cid's resume token and the server speaks protocol 2, the new socket's first frame is `resume { correlationId, resumeToken, userContext }`. The socket is not ready until `resumed` (rotated resume token).
3. **Re-sends** every frame still awaited, in the original order, each with its **original requestId** and the current token. A node visit keeps ONE requestId for all its retries and re-sends, so the server answers a re-send from its reply buffer or joins the dispatch in flight rather than running the node again.

The resume token lives in memory only — never in a URL, storage or a log line. There is **no resume across a page reload**: in a browser a `pagehide` that is not a bfcache entry cancels a running flow (best-effort); otherwise the grace ends it.

| `resume-refused` reason | What the SDK does |
|---|---|
| `token` (E3002) | `onAuthExpired` once → a string re-resumes at once, null fails the run (`Invalid token`); no hook → waits for `setAccessToken()` with a new token |
| `unavailable` (E7002 / E7101) | re-sends `resume` after the backoff, on the same socket (never a 6th on one socket: a new socket instead) |
| `gone` (E5201) / `protocol` (E2001) | the run fails — except when only the run frame had been sent and no reply came: the start is re-sent on the new cid |

| Close | What the SDK does |
|---|---|
| 1000 (`disconnect()`) | no reconnect (a running flow was cancelled first) |
| 1012 (relay restart) | reconnect after 0–1 s and resume |
| 1008 (too many refused resumes) | reconnect with the backoff |
| 4409 (superseded) | no reconnect; the running flow fails; no cancel is sent |
| 4000 (SDK liveness) | reconnect and resume |
| any other (1006 …) | reconnect with the backoff and resume |

**System messages** (`onSystem`): `close (code 1006) — reconnecting in 0.6 s (attempt 1)` · `resumed — correlationID X after 8.4 s` · `resume refused (token) — waiting for a new access token` · `resume refused (gone) — the server no longer holds this flow`.

**Failure texts** (the contract; the error is a `ConnectionLostError`, and the run sends no cancel for it):
- `connection lost — the server no longer holds this flow` — `gone` / `protocol` (the grace ran out, or a cancel came first)
- `connection taken over by another session` — close 4409
- `connection lost — this Keen server cannot resume a flow` — a drop during a running flow on a server whose welcome has no `protocol` (the socket still reconnects for the next turn)
- `Invalid token` — a token refusal whose refresh answered null

While offline the SDK keeps trying at the 10 s cap with no limit: the end of a started flow always comes from a server answer (or the user's cancel), never from a client timer.

## The flow-tree (`runFlow`'s resolution)

`ReadonlyMap<flowId, FlowTaskBundle>` where:

```ts
type FlowTaskBundle = {
  flowTask: FlowTask;      // the flow's metadata: userContext, rootFlowContext,
                           // rootAgentContext, chatContext, flowContext (entry, completed), options
  nodeTasks: NodeTask[];   // every node that ran in this flow
};
```

Each `NodeTask` carries its `nodeContext` (`kind` e.g. `startNode`/`scriptNode`/`agentNode`/`endNode`, `id`, `initial`), its request fields, and its **`response`** — the node's output envelope: `{ code: 'E1001', success: true, data: {…} }` on success (for an `agentNode` the LLM fields sit under `data.response`: `{ text, role, model, provider, usage: { inputTokens, outputTokens }, finishReason }`, next to `data.nodeTasks`), or an `E….` error code on failure. The `endNode` response carries `{ final: true, flowContext }`.

A parallel flow appears as MULTIPLE bundles in the map (one per sibling / context clone), each with its own `flowId` + `sessionId`.

## Settings (`sdk/settings.ts`)

`CHAT_SETTINGS`: `WS_URL` (`'ws://localhost/ws-keen'`, a dev literal), `RESPONSE_TIMEOUT_MS` (600 s), `RETRY_DELAY_MS` (1 s — the transport loop and the run frame's refusal retries), `RETRY_BASE_DELAY_MS` (1 s) + `RETRY_MAX_DELAY_MS` (10 s — every node's response retries, `initial: true` ones included, back off 1 → 2 → 4 → 8 → 10 s with full jitter without a limit, reset per node; an E4 `retryAfterMs` hint is honoured up to 10 s), `HEARTBEAT_INTERVAL_MS` (5 s), `CONTEXT_BATCH_SIZE` (15), `INITIAL_MAX_RETRIES` (10 — the run frame only: an E4 refusal of the first prompt is re-sent 10 × 1 s, then `runFlow` rejects with it), `MAX_FRAME_BYTES` (8 MiB — a larger outbound frame throws a non-retryable `FatalSendError` up front instead of retrying forever), `RECONNECT_BASE_MS` (1 s) + `RECONNECT_MAX_MS` (10 s) — the reconnect backoff, `RESTART_JITTER_MS` (1 s — after a 1012), `LIVENESS_MS` (15 s), `RESUME_MAX_ATTEMPTS_PER_SOCKET` (5), `PROTOCOL` (2). Per instance you can override `url`, `contextBatchSize` and `onAuthExpired` via `ChatAPIOptions`; the rest are constants.
