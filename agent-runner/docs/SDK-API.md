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
});
```

## Lifecycle (the canonical order)

```ts
chat.onStream((event, data, requestId) => { /* live progress */ });
chat.connect();                       // 1. open the WS (async handshake)
const cid = await chat.whenReady();   // 2. wait for the Keen server's welcome (assigns the connection cid)
const tree = await chat.runFlow({ chatId, prompt });  // 3. drive one flow → resolves with the flow-tree
// … read tree …
chat.disconnect();                    // 4. close
```

Skipping `whenReady()` before `runFlow()` is the classic bug: `TaskQueue` mints a fallback cid the Keen server rejects as *"correlationId does not match connection cid"*.

## Methods

### Connection
- **`connect(): void`** — open the WebSocket. No-op if already open.
- **`disconnect(): void`** — close the socket and dispose response handlers. Clears the cid.
- **`isConnected(): boolean`** — socket open?
- **`getStatus(): ConnectStatus`** — `'disconnected' | 'connecting' | 'connected'` (the type also declares `'unauthorized'`, never emitted). Drive a UI Send-gate with it.
- **`whenReady(): Promise<string>`** — resolves with the connection cid once the Keen server's `welcome` frame arrives (immediately, if already known). **It never settles if the socket closes before the welcome** (e.g. a silent origin drop) — always race it against a timeout, as `run.ts` does (15 s). **Gate `runFlow` on this.**
- **`getCorrelationID(): string | null`** — the connection cid, or null before welcome.
- **`setCorrelationID(cid): void`** — force a cid (only for a server that sends no welcome; normally untouched).

### Running
- **`runFlow(input: RunFlowInput): Promise<ReadonlyMap<string, FlowTaskBundle>>`** — drive ONE flow to completion. Resolves with the flow-tree (below). Rejects with the server/engine error (`Invalid token`, an `E….` code, `TaskQueue cancelled`, an oversized-frame `FatalSendError`, …). The SDK does all orchestration (per-node sends, parallel fan-out, retries); the engine is a pure function.
  ```ts
  interface RunFlowInput { chatId: string; prompt: string; userId?; email?; projectId?; agentId?; }
  ```
- **`isRunning(): boolean`** — a run in flight?
- **`onRunning(handler): Unsubscribe`** — fires `true` when a run starts, `false` when it settles (success / throw / cancel). Pair with `onStatus`: `canSend = status === 'connected' && !running`.

### Streaming & events (all return an `Unsubscribe`)
- **`onStream((event: string, data, requestId?) => void)`** — every engine → user progress frame (token text, `<SYSTEM CALL>` directives). The live view. **This is the "hook"** a headless runner turns into stdout.
- **`onStatus(handler)`** — connection status changes.
- **`onSystem(handler)`** — socket-level notes (open/close/error/parse failure) as plain strings.
- **`onWelcome(handler)`** — fires once per connection with `{ correlationID }`.

### Stopping (cancel)
- **`cancel(): void`** — THE consumer-facing cancel. Stops the local drain loop, sends the `cancel` frame for the run's cid (the Keen server wipes that cid's `dict` / `session` / `agentState` / queue, so a half-run leaves nothing behind) and clears local state; the pending `runFlow` promise rejects with `TaskQueue cancelled`. Safe to call when idle.
  ```ts
  chat.cancel();                     // cancel the current run
  ```
- **`sendCancel(correlationID?: string): boolean`** — low-level: fires ONLY the cancel frame (defaults to the connection cid), no local cleanup. Returns `false` if the socket is not open or no cid is known. Do **not** use it to stop a run from your own client — the drain loop keeps going, the wiped cid answers `E6002`, which the SDK classifies as retryable, and a continuation then retries forever. `run.ts` calls it on `SIGINT` only because it `disconnect()`s and exits `130` right after — so Ctrl+C really stops the flow on the engine, not just the client.

### Low-level (not needed by a runner)
- **`onResponse(handler)`** — every response envelope · **`waitFor(requestId)`** — the pending-reply promise · **`send()` / `sendNodeTask()` / `sendContextRun()`** — the raw frame senders `TaskQueue` uses · **`sendMessage()`** — send + waitFor in one · **`getUrl()`**.

### Token refresh
- **`setAccessToken(accessToken: string): void`** — replace the bearer used inside every subsequent run/continuation frame WITHOUT tearing down the socket (the Keen server verifies it per-frame). Call it when a token is about to expire during a long session. The current connection/cid is preserved.

### Heartbeat
Automatic. While a `runFlow` is in flight `TaskQueue` fires `chat.sendPing()` every `CHAT_SETTINGS.HEARTBEAT_INTERVAL_MS` (5 s) to refresh the engine-side TTLs (dict/session/agentState), and stops on settle. You do not call it yourself.

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

`CHAT_SETTINGS`: `WS_URL` (`'ws://localhost/ws-keen'`, a dev literal), `RESPONSE_TIMEOUT_MS` (600 s), `RETRY_DELAY_MS` (1 s), `HEARTBEAT_INTERVAL_MS` (5 s), `CONTEXT_BATCH_SIZE` (15), `INITIAL_MAX_RETRIES` (10), `MAX_FRAME_BYTES` (8 MiB — a larger outbound frame throws a non-retryable `FatalSendError` up front instead of retrying forever). Per instance you can override `url` and `contextBatchSize` via `ChatAPIOptions`; the rest are constants.
