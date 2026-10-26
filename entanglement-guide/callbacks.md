# Callbacks

`ChatAPI` exposes six subscription callbacks. Getting the split right is the whole
game — especially **`onStream` (application output) vs `onSystem` (transport
diagnostics)**. All six are registered *before* `connect()` (see
[`chat-sdk.md`](chat-sdk.md)); each returns an unsubscribe function.

Signatures are verified in `connect.ts`, `response.ts`, and `index.ts`; usage in
`components/ui-chat/chat-shell/component.tsx`.

---

## `onStream` — the live agent output  ← this is the answer

```ts
type StreamEventHandler = (
  event: string,                    // 'token' | 'thinking' | 'processing' | 'progress' | 'error' | …
  data: InboundFrame['data'],       // the frame payload (text on data.text, or JSON on data.data)
  requestId?: string
) => void;

instance.onStream((event, data, requestId) => { … });
```

**Fires for every inbound frame WITHOUT an envelope** — the engine → user progress
stream. This is where the model's answer actually arrives (NOT from `runFlow()`'s
return value, which is the flow‑tree snapshot for inspection).

What the app does with it — the key rule is **`event === 'token'` is the streaming
text**, everything else is a step or an error:

```tsx
instance.onStream((event, data) => {
  const text = streamText(data);           // data.text, or JSON.stringify(data.data)
  if (!text) return;

  if (event === 'token') {
    // Append to the CURRENT agent row (map over messages, replace it in place);
    // the first token after a reset opens a new agent row.
    …
    return;
  }

  // Any other event closes the current agent row: the next token opens a new one,
  // so the rows keep the order things happened in.
  agentMessageId.current = null;

  // thinking / processing / progress → an 'event' row; 'error' → an 'error' row.
  setMessages(prev => appendCapped(prev, {
    id, role: event === 'error' ? 'error' : 'event', event, text, at: Date.now()
  }));
});
```

The transcript then folds those rows into one **turn** per prompt
(`chat-messages/turns.ts`):

- **`thinking` / `processing` / `progress`** (and any other event name) become
  steps of the turn's **run trace** — a collapsible timeline, open while the turn
  runs (so a long, multi‑step run reads as progress, not a frozen screen), then
  collapsed unless the reader turned **Steps** on.
- **`token`** text is split around the `<SYSTEM CALL>…</SYSTEM CALL>` fences the
  agent writes: each fence becomes a tool‑call step; prose **before the last tool
  call** becomes a note step ("let me check that…"); prose **after the last tool
  call** is **the answer**, rendered as markdown. A turn with no tool call shows all
  its prose as the answer.
- **`error`** renders as the turn's "Something went wrong" block.

For a flow author: what the user reads first is the prose your agent emits after
its last tool call. Narration before a tool call, and every progress event, sit in
the trace — visible while the turn runs, folded away once it is done.

> A WebSocket close (e.g. 1006) does **not** arrive here — it surfaces on
> `onSystem`. `onStream` only carries frames the Keen server actually sent over an
> open socket.

---

## `onSystem` — transport diagnostics only  ← NOT application output

```ts
type SystemHandler = (text: string) => void;

instance.onSystem(text => { … });
```

**Fires for socket‑level events only**, emitted by `WSConnectAPI`:

- `open <url>` — socket opened
- `close (code <n>, <reason>)` — socket closed (this is where a **1006** / **1009**
  close shows up)
- `socket error`
- `non-JSON frame: …` / `malformed welcome frame: …` — a parse failure
- `welcome — correlationID <cid>` — the connection greeting
- `failed to construct WebSocket: <msg>` — the URL was malformed; no socket was
  opened (status stays `disconnected`)

These are **diagnostics**, not chat content. Wire `onSystem` to a log/console for
debugging connectivity; never render it as the agent's answer. In entanglement the
chat shell doesn't subscribe to it at all — the connection state the user sees
comes from `onStatus` instead. The shell also never reconnects on its own: after a
close the status stays `disconnected` and Send stays off until the page is
reloaded.

---

## `onStatus` — connection lifecycle

```ts
type ConnectStatus = 'disconnected' | 'connecting' | 'connected' | 'unauthorized';
type StatusHandler = (status: ConnectStatus) => void;

instance.onStatus(status => setStatus(status));
```

Fires synchronously on each socket transition. The chat UI drives everything off
it: the chat header and the prompt box show the status, and Send is gated on
`connected`.
(`'unauthorized'` is a reserved state for a future server‑side auth‑close.)

---

## `onRunning` — is a flow in flight

```ts
type RunningHandler = (running: boolean) => void;

instance.onRunning(running => setRunning(running));
```

Fires **`true`** the instant `runFlow()` starts and **`false`** when it settles
(success, throw, or cancel); idempotent (no duplicate transitions). This is the
canonical Send‑button gate — pair it with `onStatus`:

```ts
const canSend = status === 'connected' && !running && prompt.trim().length > 0;
```

The shell also uses the `true` edge to reset the "current agent row" ref so each
turn starts its own agent row, and the chat page uses the `false` edge to re‑read
the conversation list (a brand‑new chat appears in the sidebar once its first turn
settles). While `running` is true the Send button is a **Stop** button
(`cancel()`).

---

## `onWelcome` — the connection id arrived

```ts
type WelcomeHandler = (payload: { correlationID: string }) => void;

instance.onWelcome(({ correlationID }) => { … });
```

Fires once per WS connection, immediately after the Keen server sends its `welcome`
frame. After it fires, `chat.getCorrelationID()` returns a string. Most apps don't
need it directly — `TaskQueue` uses the correlationID internally — but it's there
for callers that want to gate on the connection being fully established.

---

## `onResponse` — every reply envelope (advanced)

```ts
type ResponseHandler = (envelope: Envelope, requestId: string) => void;

instance.onResponse((envelope, requestId) => { … });
```

Fires for **every** response envelope (the counterpart of `onStream`). `TaskQueue`
consumes replies via `waitFor(requestId)`, so app code rarely needs this — it's for
a log / stats / inflight panel that wants to see every reply. entanglement's chat UI
does not use it.

---

## Quick reference

| Callback | Fires on | Carries | Use it for |
|----------|----------|---------|------------|
| `onStream` | frames **without** an envelope | `(event, data, requestId)` | **the agent's text** (`event==='token'`) + the run‑trace steps / error block |
| `onSystem` | socket‑level events | `text` | connectivity **diagnostics** (open/close/error/parse); WS close codes (e.g. 1006) |
| `onStatus` | socket transitions | `ConnectStatus` | connection UI + the Send gate |
| `onRunning` | run start / settle | `boolean` | the Send/Stop gate; per‑turn row reset; list refresh on settle |
| `onWelcome` | once per connection | `{ correlationID }` | gate on the connection being ready |
| `onResponse` | frames **with** an envelope | `(envelope, requestId)` | log/stats panels (advanced) |
