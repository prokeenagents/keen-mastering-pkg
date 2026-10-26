# The ChatSDK

The chat client is a small, self‑contained TypeScript SDK in
`src/service/services/chat/`. Every import inside it is relative, so it can be
lifted into its own package; a *copy* of the same SDK (`agent-runner/sdk/`) also
runs headless in the sibling `agent-runner` CLI, so it is transport‑agnostic about
who drives it.

It is built as **five layers**, each a single class with one job. You use only the
top one — **`ChatAPI`** — but knowing the layers explains the behaviour you'll see.

```
ChatAPI            index.ts        the front door — construct this
  ├─ TaskQueue     task-queue.ts   the flow-tree state machine (runFlow)
  ├─ SendRequest   send-request.ts builds the run frame, retries, size-guards
  ├─ ResponseAPI   response.ts     splits envelopes vs stream, waitFor(requestId)
  └─ WSConnectAPI  connect.ts      the WebSocket transport + welcome→correlationID
```

---

## 1. The layers, bottom‑up

### WSConnectAPI — transport + welcome
`connect.ts`

Owns the WebSocket lifecycle: open, close, track status, route inbound frames.

- The transport carries **no auth**. The user's token rides *inside* every run
  payload's `userContext` — the initial run **and** every continuation / clone
  frame re‑stamp it (kept out of URLs and logs) — because the Keen server verifies
  it per frame.
- On open, the Keen server sends a one‑time **`welcome`** frame carrying a
  **`correlationID`** — the per‑connection id used as the chat's identifier for the
  whole WS lifetime (cancel signals, later calls). WSConnectAPI captures it and
  fires `onWelcome`.
- Inbound frames are handed to `ResponseAPI`; socket‑level events (open/close/
  error/parse failure) are surfaced via `onSystem`.
- `sendFrame(frame)` returns a boolean (queued on an OPEN socket or not) — the
  retry logic lives one layer up, never here.

### ResponseAPI — envelope vs stream, and `waitFor`
`response.ts`

The inbound counterpart. It routes each frame by whether it carries an **envelope**:

```ts
handle(frame) {
  const envelope = frame.data?.envelope;
  if (envelope) { /* resolve any waitFor(requestId), fire onResponse */ }
  else          { /* fire onStream(event, data, requestId) */ }
}
```

- **Response frames** carry an `envelope` — they resolve the matching
  `waitFor(requestId)` promise and notify `onResponse`.
- **Stream frames** have no envelope — the agent's live progress/output — and
  notify `onStream`.
- `waitFor(requestId, timeoutMs?)` resolves with the envelope for that request, or
  **rejects on timeout** (default `RESPONSE_TIMEOUT_MS`, 10 min) so a lost reply
  can't hang a caller forever.

### SendRequest — the run frame, retry, and the size guard
`send-request.ts`

Builds a `{ event: 'run', data: { requestId, payload } }` frame and runs the retry
loop. Two important behaviours:

- **Fresh `requestId` per `execute()`**, reused across that call's retries (so the
  server's same‑id retry dedup holds). Ids are globally unique v4 UUIDs.
- **The pre‑send size guard.** Before sending, it measures the frame; a frame over
  `CHAT_SETTINGS.MAX_FRAME_BYTES` (**8 MB** — a per‑message size cap on the Keen
  server) can never be delivered, so it throws a **non‑retryable** `FatalSendError`
  instead of retrying forever:

```ts
const bytes = byteLength(JSON.stringify(frame));
if (bytes > CHAT_SETTINGS.MAX_FRAME_BYTES) {
  throw new FatalSendError(`frame is …MB, over the …MB limit … aborting the run.`);
}
```

Its retry is the **transport** retry — re‑sending, 1 s apart, while the socket isn't
open; it never looks at the reply. Policy is per‑call: **bounded (10 attempts)** for
the *initial* run (a failed start means the user's request never began) and
**infinite** for continuations (the flow is already alive on the server; keep trying
until the socket recovers).

### TaskQueue — the flow‑tree state machine
`task-queue.ts`

Drives one chat's flow from the initial prompt to a terminal state across a whole
tree of "bundles" (the root flow, `runFlow` children, `parallelIn` siblings,
`parallelContext` copies). This is what `runFlow()` calls. You don't touch it
directly; what matters is its behaviour:

- **Client owns the flow's identity.** `sessionId` and `requestId` are minted here
  *before* the first frame goes out; `correlationId` is the connection cid the Keen
  server assigned in the `welcome` frame (a client‑minted one is only the
  no‑welcome fallback, and the server rejects a mismatch with `E2001`). The server
  echoes all three so state is stable across the round trip.
- **Drain loop.** It sends the initial prompt, receives the root bundle, then keeps
  firing pending per‑node calls until every bundle is complete. Parallel host nodes
  are normalised so a node stays pending until all its children finish. A large
  `parallelContext` fan‑out is drained in **batches of 15** so it never floods the
  Keen server (`CONTEXT_BATCH_SIZE`).
- **Response retry — per‑node calls only.** On a non‑success, *non‑terminal*
  envelope to a per‑node call it waits 1 s and re‑issues the whole send+waitFor (up
  to 10 times for an `initial` node, forever for continuations). Terminal codes
  (`E2…` / `E3…` / `E8…`) are surfaced, not retried. The **initial run frame** gets
  no response retry: any non‑success reply to it — `E4…` backpressure included —
  throws at once and `runFlow()` rejects (see [`errors.md`](errors.md) §1).
- **Heartbeat.** While a run is in flight it fires a `ping` every ~5 s
  (`HEARTBEAT_INTERVAL_MS`) so the run's server‑side state doesn't expire during
  idle gaps (slow model, queued call).
- **One failure boundary.** Any throw (transport exhaustion, timeout, terminal
  error, a `FatalSendError`) funnels through one catch that fires a cancel to wipe
  the run's server‑side state for this connection, then re‑throws — so a failed
  `runFlow()` leaves nothing to clean up.
- **Cancel** sets a flag, fires one cancel signal (covers the whole tree — all
  bundles share the correlationId), and clears local state.

### ChatAPI — the front door
`index.ts`

The only class app code depends on. It composes the four layers and exposes the
public surface: `connect` / `disconnect`, `whenReady()` (resolves with the cid once
the `welcome` frame has landed — gate a headless first send on it), `runFlow`,
`setAccessToken`, `cancel`, `isRunning`, and the callback subscriptions (`onStatus` /
`onStream` / `onSystem` / `onRunning` / `onResponse` / `onWelcome`).

`index.ts` also exports **`KeenChat`** (`keen-chat.ts`) — the minimal headless
connector: `new KeenChat({ ws, token, email })`, then `connect()`,
`run({ agentId, spaceId, chatId, prompt })`, `setToken()`, `cancel()`, with
`onStream` / `onStatus` / `onSystem`. It does no partner work (no certificate, no
application token) and derives `userId` from the token's `sub`.

---

## 2. Constructor options

```ts
new ChatAPI({
  spaceID,      // the space the run targets
  agentID,      // the agent SLUG — NOT the row id/cuid (a cuid comes back as E3101)
  userId,       // the signed-in consumer's id
  email,        // the signed-in consumer's email
  accessToken,  // the session access token (sent inside the initial run payload)
  url,          // optional — the Keen WebSocket endpoint; defaults to CHAT_SETTINGS.WS_URL
  projectID,    // optional — defaults to spaceID (space id === project id)
  cookies,      // optional — string[] of names OR { name: value } map (see cookies.md)
  contextBatchSize // optional — max parallelContext copies drained per wave;
                   // defaults to CHAT_SETTINGS.CONTEXT_BATCH_SIZE (15). Only a
                   // positive integer is honoured; anything else uses the default.
});
```

Key points:

- **`agentID` must be the agent's SLUG** (`agentId`), not the row id. Passing the
  cuid gets you `E3101` with the message `agent "<id>" not found in space <spaceId>`
  — one of several `E3101` refusals, all listed in [`errors.md`](errors.md) §1. In
  this app the shell resolves the slug: `const agentSlugID = selectedAgent?.agentId`.
- **`accessToken` is not readonly.** The Keen server verifies it on *every* run
  frame, so a refreshed token must land on the next send without reconnecting — use
  `setAccessToken()`. (See §4.)
- **`url`** defaults to the SDK's `CHAT_SETTINGS.WS_URL`; entanglement passes the
  server‑provided `consumer.wsUrl` instead so the endpoint is deployment‑correct.
  On plain http use a `ws://` URL; an `https` deployment must use `wss://`.
  `consumer.wsUrl` is just `process.env.KEEN_WS` — leave it unset and `url` is
  `undefined`, so the SDK silently falls back to `ws://localhost/ws-keen`, which
  never connects to a Keen nginx edge: port 80 only redirects to https, and a
  WebSocket upgrade doesn't follow redirects (close 1006). Set `KEEN_WS`; the
  working local values are in [`README.md`](README.md), *A local Keen stack*.

---

## 3. The instantiation pattern (exactly as ChatShell does it)

This is the canonical way to embed the chat. From
`src/components/ui-chat/chat-shell/component.tsx` — build + connect **once in a
`useEffect`**, store the instance in a **ref**, register callbacks **before**
`connect()`, tear down on unmount:

```tsx
useEffect(() => {
  // No identity = don't even open a socket (the server would refuse the run).
  if (!agentSlugID || !userID || !email || !accessToken) return;

  // Born HERE, never in render (render would mint one per re-render, and
  // connect() has no WebSocket during SSR).
  const instance: App.ChatUI.Client = consumer.demo
    ? new DemoChatClient(agentSlugID)     // demo mode: an in-memory agent, same surface
    : new ChatAPI({
        spaceID,
        agentID: agentSlugID,   // the SLUG
        userId: userID,
        email,
        accessToken,
        url: consumer.wsUrl
      });

  // Register callbacks BEFORE connect() so no early frame is missed.
  instance.onStatus(next => setStatus(next));
  instance.onRunning(next => { setRunning(next); if (next) agentMessageId.current = null; });
  instance.onStream((event, data) => { /* tokens → the current agent row; events → rows */ });

  chatRef.current = instance;
  instance.connect();

  return () => {                 // cleanup on unmount / thread change
    instance.disconnect();
    chatRef.current = null;
    setStatus('disconnected');
    setRunning(false);
  };
  // accessToken is deliberately NOT a dependency — see §4.
}, [chatID, spaceID, agentSlugID, userID, email, consumer.demo]);
```

The ref is typed as `App.ChatUI.Client` — the slice of the SDK the UI drives
(`onStatus` / `onRunning` / `onStream`, `connect` / `disconnect`,
`setAccessToken`, `runFlow`, `cancel`). `ChatAPI` satisfies it structurally; with
`ENTANGLEMENT_DEMO=1` in dev the shell swaps in `DemoChatClient` (`src/demo/`), an
in‑memory agent that streams thinking steps, a tool call and a markdown answer
without any Keen server.

Why each rule:

- **In an effect + ref, not render** — constructing is cheap and side‑effect‑free
  (the socket opens only on `.connect()`), but building it during render mints a
  fresh client every re‑render, and `connect()` can't run during SSR.
- **Callbacks before `connect()`** — so the `welcome` frame and any early stream
  events are already subscribed.
- **`disconnect()` on unmount** — closes the socket and rejects pending `waitFor`
  promises, so route changes / HMR don't leak sockets or hanging awaits.
- **`accessToken` excluded from the deps** — a token refresh must NOT tear down the
  socket. It's synced separately (§4).

### Sending a turn

```ts
await instance.runFlow({ chatId: chatID, prompt: trimmed });
```

`chatId` is **required** (every stored turn is keyed by it); `userId`, `email`,
`projectId`, `agentId` all default to the constructor values and can be overridden
per call via `RunFlowInput`.

The shell wraps this in `send`, appending the user's row first and handling the
outcome:

```ts
try {
  await instance.runFlow({ chatId: chatID, prompt: trimmed });
} catch (err) {
  if (err.message === 'TaskQueue cancelled') { /* quiet 'canceled' row → "Stopped" */ }
  else                                       { /* 'error' row → "Something went wrong" */ }
}
```

A concurrent `runFlow` is rejected with `"TaskQueue already running — call clear()
or cancel() first"` (match on the prefix, not equality), which is why the prompt
UI gates Send on `running`.

---

## 4. Keeping the token fresh without reconnecting

The socket's lifetime is bound to the connection's **correlationID**, not to the
token — but the Keen server verifies the token on **every** run frame, so a chat
left open long enough would start failing sends with `E3002`. The SDK is built for
this: `accessToken` is mutable via `setAccessToken()`, so a refresh lands on the
*next* send without dropping the socket.

ChatShell keeps two effects for this (both separate from the build‑once effect):

```tsx
// Push a new token onto the live instance whenever the prop changes.
useEffect(() => { if (accessToken) chatRef.current?.setAccessToken(accessToken); }, [accessToken]);

// And rotate it on an interval while the chat is open (the token outlives a
// server re-render, which a long-lived thread never triggers on its own).
useEffect(() => {
  const timer = setInterval(() => {
    if (!chatRef.current) return;
    void checkAndRefreshToken().then(token => { if (token) chatRef.current?.setAccessToken(token); });
  }, TOKEN_REFRESH_INTERVAL_MS);
  return () => clearInterval(timer);
}, [checkAndRefreshToken]);
```

`checkAndRefreshToken()` (from `useAuth()`) calls `/api/refresh`; when the current
token still has life the Keen server answers with its "still valid" fast path and
mints nothing, so this is cheap to call. A `null` result means the refresh failed
(a spent/expired refresh token — or a transport error, which looks the same): the
SDK is left alone with its stale token, the next send surfaces `E3002`, and the
next navigation bounces to `/login` through the proxy. Nothing signs the user out
proactively — the `logout` event handler only fires on an org webhook.

---

## 5. What `runFlow` resolves to (vs where the answer arrives)

**`runFlow()` resolves to the flow‑tree snapshot** — a readonly map of every bundle
that ran. That is for **inspection** (visualising the tree, per‑node responses),
**not** the agent's answer.

**The agent's answer arrives via `onStream`.** Token events accumulate into the
current agent row; any other event (thinking / processing / progress / error) is
its own row and closes the current agent row, so the next token opens a new one.
The transcript then folds the rows into a turn: events and tool calls into a
collapsible run trace, the prose after the last tool call into the answer. See
[`callbacks.md`](callbacks.md) for the full split — it's the one thing most worth
internalising: the text a user reads does not come out of the `await`.

```tsx
// The answer is HERE, not from the runFlow() return value.
instance.onStream((event, data) => {
  const text = streamText(data);
  if (event === 'token') { /* append to the current agent row */ }
  else                   { /* close that row; add an event / error row */ }
});
```

---

## 6. Settings (`settings.ts`)

Every default the SDK uses is in `CHAT_SETTINGS`; override per deployment through
`ChatAPIOptions` rather than editing the numbers.

| Constant | Default | Meaning |
|----------|---------|---------|
| `WS_URL` | `ws://localhost/ws-keen` | fallback when no `url` is passed. It doesn't reach a Keen nginx edge (port 80 only redirects), so always pass `ChatAPIOptions.url` — `wss://keen.example.com/ws-keen`; local values in [`README.md`](README.md). `ws://` only on plain http, `wss://` on https. |
| `RESPONSE_TIMEOUT_MS` | 600000 (10 min) | how long `waitFor` waits for a reply. |
| `RETRY_DELAY_MS` | 1000 | backoff between retries. |
| `HEARTBEAT_INTERVAL_MS` | 5000 | ping cadence while a run is in flight. |
| `CONTEXT_BATCH_SIZE` | 15 | max `parallelContext` copies drained per wave. Override per instance with `ChatAPIOptions.contextBatchSize` (positive integer). Raising it past what the Keen server admits at once just meets backpressure (retried), not more throughput. |
| `INITIAL_MAX_RETRIES` | 10 | transport retries for the initial run frame, and response retries for an `initial` node. The initial run frame's *reply* is never retried. |
| `MAX_FRAME_BYTES` | 8 MB | hard cap on a single outbound frame (see the size guard). |
