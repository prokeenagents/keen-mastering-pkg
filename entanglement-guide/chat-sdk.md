# The ChatSDK

The chat client is a small, self‑contained TypeScript SDK in
`src/service/services/chat/`. Every import inside it is relative, so it can be
lifted into its own package; the same SDK also runs headless in the sibling
`agent-runner` CLI, so it is transport‑agnostic about who drives it.

This page describes the SDK **the public site ships today**. It runs against
Keen 15.3, but it does not use what 15.3 added to the chat (a dropped socket
resumed, the prompt limit announced, the token refreshed by the SDK itself). The
toolkit's `agent-runner/sdk/` already is the 15.3 SDK, and a site update for 15.3
is coming; §8 lists the differences.

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
  fires `onWelcome`. Keen 15.3's welcome also carries `resumeToken`, `graceMs`,
  `protocol` and `limits.promptChars`; this SDK reads only `correlationID`.
- Inbound frames are handed to `ResponseAPI`; socket‑level events (open/close/
  error/parse failure) are surfaced via `onSystem`.
- **A dropped socket is not reopened.** The status goes `disconnected` and stays
  there; a running flow cannot continue on it (§5).
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

- **A fresh `requestId` per `execute()`.** Every call mints a new globally unique
  v4 UUID, and its transport retries reuse it. A response retry (§TaskQueue) is a
  new `execute()`, so it goes out as a new request.
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
the run frame and for a node marked `initial`, and **infinite** for every other
node (the flow is already alive on the server; keep trying until the socket is
back — which, in this SDK, only a new instance brings).

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
  envelope to a per‑node call (or a `waitFor` timeout) it waits 1 s and re‑issues
  the whole send+waitFor: at most 10 times for a node marked `initial` (then the
  run fails with `max response retries exceeded for node <id>; last error: …`),
  without a limit for every other node. Terminal codes (`E2…` / `E3…` / `E8…`) are
  surfaced, not retried — `E3002` included. The **run frame** (the first prompt)
  is never retried on its reply: any non‑success reply to it — a busy `E4…` too —
  makes `runFlow()` reject at once with the server's message (see
  [`errors.md`](errors.md) §1).
- **Heartbeat.** While a run is in flight it fires a `ping` (`{}`) every ~5 s
  (`HEARTBEAT_INTERVAL_MS`) so the run's server‑side state doesn't expire during
  idle gaps (slow model, queued call). Keen 15.3 answers a `pong` only to a ping
  that names `protocol: 2`, so this SDK gets none.
- **One failure boundary.** Any throw (transport exhaustion, timeout, terminal
  error, a `FatalSendError`) funnels through one catch that fires a cancel to wipe
  the run's server‑side state for this connection, then re‑throws — so a failed
  `runFlow()` leaves nothing to clean up.
- **Cancel** sets a flag, fires one cancel signal once the first reply has named
  the flow (it covers the whole tree — all bundles share the correlationId),
  clears local state, and `runFlow()` rejects with `TaskQueue cancelled` when the
  call in flight returns.

### ChatAPI — the front door
`index.ts`

The only class app code depends on. It composes the four layers and exposes the
public surface: `connect` / `disconnect` (closes the socket and rejects every
pending `waitFor`; it sends **no** cancel), `whenReady()` (resolves with the cid
once the `welcome` frame has landed — gate a headless first send on it),
`isConnected()`, `runFlow`, `setAccessToken`, `cancel`, `isRunning`, and the
callback subscriptions (`onStatus` / `onStream` / `onSystem` / `onRunning` /
`onResponse` / `onWelcome`).

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
  contextBatchSize  // optional — max parallelContext copies drained per wave;
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
  promises, so route changes / HMR don't leak sockets or hanging awaits. It does
  not cancel a running flow, and Keen 15.3 does not take a close as a cancel: the
  relay holds the flow for its resume grace (120 s by default), then ends it. Call
  `cancel()` first when a turn is running and you want it gone at once.
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

`checkAndRefreshToken()` (from `useAuth()`) calls `/api/refresh` (one request in
flight at a time); when the current token still verifies the Keen server answers
with its "still valid" fast path (`Token is still valid!`, `statusCode: 100`) and
mints nothing, so this is cheap to call. A `null` result means the refresh failed
(a spent/expired/revoked refresh token — or a transport error, which looks the
same): the SDK is left alone with its stale token, the next send surfaces `E3002`,
and the next navigation bounces to `/login` through the proxy. Nothing signs the
user out proactively — the `logout` event handler only fires on an org webhook.

The tick is `TOKEN_REFRESH_INTERVAL_MS` = 5 minutes, and the fast path rotates
nothing while the token still has life. With Keen 15.3's **10‑minute** access token
the token on the socket can therefore expire up to ~5 minutes before the next tick
replaces it; a turn sent in that gap fails with `E3002` (this SDK does not refresh
on a refusal), and the next tick or a reload fixes it.

---

## 5. A dropped connection

A dropped WebSocket (Wi‑Fi roam, laptop lid, a relay restart) closes this SDK's
connection for good: the status goes `disconnected`, `onSystem` reports
`close (code <n>…)`, and nothing reconnects. The chat shows "Disconnected" and
Send stays off until the page builds a new `ChatAPI` — a
reload, or opening the chat again.

A turn that was running does not end by itself: its pending reply waits out
`RESPONSE_TIMEOUT_MS` (10 min) and its node is then re‑sent onto the closed socket
(an `initial` node until its 10 tries fail, any other without a limit), so the turn
looks stuck until the user presses **Stop**. On the
Keen side (15.3) the relay holds the detached flow for its resume grace (120 s by
default) and then ends it, since this SDK never sends the `resume` that would
re‑bind it. Re‑read the transcript from the history route after a reload; the
answer of an interrupted turn is not replayed.

---

## 6. What `runFlow` resolves to (vs where the answer arrives)

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

## 7. Settings (`settings.ts`)

Every default the SDK uses is in `CHAT_SETTINGS`; override per deployment through
`ChatAPIOptions` rather than editing the numbers.

| Constant | Default | Meaning |
|----------|---------|---------|
| `WS_URL` | `ws://localhost/ws-keen` | fallback when no `url` is passed. It doesn't reach a Keen nginx edge (port 80 only redirects), so always pass `ChatAPIOptions.url` — `wss://keen.example.com/ws-keen`; local values in [`README.md`](README.md). `ws://` only on plain http, `wss://` on https. |
| `RESPONSE_TIMEOUT_MS` | 600000 (10 min) | how long `waitFor` waits for a reply. |
| `RETRY_DELAY_MS` | 1000 | the pause between transport retries (socket not open) and between a node's response retries. |
| `HEARTBEAT_INTERVAL_MS` | 5000 | ping cadence while a run is in flight. |
| `CONTEXT_BATCH_SIZE` | 15 | max `parallelContext` copies drained per wave. Override per instance with `ChatAPIOptions.contextBatchSize` (positive integer). Raising it past what the Keen server admits at once just meets backpressure (retried), not more throughput. |
| `INITIAL_MAX_RETRIES` | 10 | the bound of the run frame's transport retries, and of an `initial` node's transport and response retries. Every other node is unbounded. |
| `MAX_FRAME_BYTES` | 8 MB | hard cap on a single outbound frame (see the size guard). |

---

## 8. Keen 15.3's Chat SDK — what the coming site update changes

The toolkit's `agent-runner/sdk/` is the 15.3 SDK (full reference:
[`agent-runner/docs/SDK-API.md`](../agent-runner/docs/SDK-API.md)). The site update
for 15.3 brings the same SDK to the site. Against the SDK above it:

| Topic | The public site's SDK (above) | The 15.3 SDK |
|---|---|---|
| A dropped socket | stays `disconnected`; the turn looks stuck until Stop | reconnects (full jitter 1 → 10 s, no limit; 0–1 s after a 1012), sends `resume`, and re‑sends every awaited node with its original requestId; status `'reconnecting'`, `onResume({ correlationID, detachedMs })` |
| A flow the server no longer holds | — | `runFlow` rejects `connection lost — the server no longer holds this flow` (the grace ran out) or `connection taken over by another session` (close 4409) |
| requestId | new per send | one per node visit, kept across retries and resumes (the relay answers a re‑send from its reply buffer) |
| Node retries | 1 s fixed; `initial` nodes at most 10 | every node without a limit, backoff 1 → 2 → 4 → 8 → 10 s with full jitter (or the reply's `retryAfterMs`) |
| The run frame | any refusal rejects at once | an `E4…` refusal is re‑sent 10 × 1 s, then rejects |
| An expired token | `E3002` is terminal | `onAuthExpired: () => Promise<string \| null>` refreshes once and re‑sends the same node (and a refused resume) |
| Heartbeat | `ping {}`; no `pong` | `ping { protocol: 2 }`, `pong`; 15 s of silence closes (4000) and resumes |
| `disconnect()` | no cancel | cancels a running flow first |
| The prompt limit | — (the server's `E2101` arrives as the turn's error, [`errors.md`](errors.md) §1) | `getPromptLimit()` from `welcome.limits.promptChars` (20 000), for a counter and to stop the send |
| The Summarizer | — | `onSummarizing(active)` while a Summarizer node runs |

`KeenChat` stays the site's own headless connector; `agent-runner/sdk/` does not
carry it.
