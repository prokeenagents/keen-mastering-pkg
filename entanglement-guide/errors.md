# Errors

The failures an integrator or a flow‑building agent will actually meet, in three
groups: the **`E….` status codes** the Keen server puts in reply envelopes, the
**SDK‑level failures** the client raises itself, and the **transport‑level**
signals (WebSocket close codes, and the HTTP refusals of the site's own routes).

---

## 1. The `E….` status‑envelope codes

Every chat reply is an envelope: `{ success, code, message?, data? }`. On a failure
the `code` is an `E….` string and `message` is the human text from the Keen server.

### The prefix convention (this is the retryability contract)

The **letter‑group after `E` is the class**, and the class decides whether the SDK
retries a **per‑node call**. `TaskQueue.isTerminalErrorCode` is the authority:

```ts
// task-queue.ts
private isTerminalErrorCode(code) {
  return code.startsWith('E2') || code.startsWith('E3') || code.startsWith('E8');
}
```

| Prefix | Meaning | SDK behaviour |
|--------|---------|---------------|
| `E1…` | success (e.g. `E1001` OK) | — |
| `E2…` | **client error** — bad/malformed/duplicate input; won't fix itself | **terminal** — surfaced, run fails |
| `E3…` | **auth failure** — bad/expired token, not authorized | **terminal** — surfaced |
| `E4…` | **capacity / backpressure** | **retried** on a per‑node call (1 s backoff) |
| `E5…` | resource | retried on a per‑node call |
| `E6…` | system | retried on a per‑node call |
| `E7…` | upstream | retried on a per‑node call |
| `E8…` | **explicit cancellation** | **terminal** — surfaced |

This split applies to the **per‑node calls** that follow the first reply: a
non‑terminal code is re‑issued after 1 s — up to 10 times on an `initial` node,
forever on a continuation — while `E2…` / `E3…` / `E8…` end the run at once.

The **initial run frame** (the turn's first frame, the one carrying the prompt) is
different: *any* non‑success reply to it, `E4…` included, throws straight away
(`task-queue.ts`: `if (!envelope.success) throw new Error(envelope.message ?? envelope.code)`),
so `runFlow()` rejects with the server's message. A capacity refusal at the start of
a turn is surfaced, not retried — send the turn again.

### The common codes you can rely on

These are the ones actually referenced in the client; the **precise code and text
always come from the Keen server in the envelope `message`** — don't hard‑code an
exhaustive list.

- **`E3002` — invalid / expired token.** The Keen server verifies the access token
  on *every* run frame and rejects an expired one with `E3002` **without closing the
  socket** (the connection's lifetime is bound to its correlationID, not the token).
  Recovery: refresh the token and apply it with `setAccessToken()` — the next send
  succeeds, no reconnect. entanglement does this on an interval via
  `/api/refresh` + `checkAndRefreshToken()`.

- **`E3101` — the relay's authorization class.** The overwhelmingly common cause is
  **passing the agent's row id (a cuid) instead of its slug** (`agentId`). Construct
  `ChatAPI` with the slug. The relay raises it, in this order, when:
  `chatContext.projectId` is missing; the space isn't in the token's `space` claim;
  the space isn't in the consumer contract's *current* spaces; **the consumer
  contract key was rotated org‑side** (the token's `consumerContractKey` claim no
  longer matches — the token is stale and only a **re‑login** fixes it, since
  `/api/refresh` re‑mints the same stale key); or the agent slug isn't an active
  agent of that space (removed / disabled org‑side).

- **`E2…` — a bad or missing request field** (the client‑error class). A concrete
  member the client names is **`E2003` "Duplicate requestId"**. The `E2` class
  covers malformed / missing context fields generally (for example a required
  context field being absent); the specific code arrives in the envelope `message`.

You may also see **`E6002`** with the engine text `Dictionary/Session <id> not
found; flow may be cancelled or stale` — a run's server‑side state was gone when a
later frame arrived (after a cancel, or the 60 s state TTL passed). It's in the
`E6` class, so the SDK retries it rather than failing outright — and on a
continuation that retry is **infinite** (once a second) until the user cancels, so a
stale flow does not fail by itself. The state never comes back, so those retries
cannot succeed: the turn just looks stuck. Recover by cancelling (`cancel()`, the
chat's Cancel button) and sending the turn again. On an `initial` node it gives up
after 10 tries with `max response retries exceeded for node …`.

### How the app renders an `E….`

`TaskQueue` throws `new Error(envelope.message ?? envelope.code)` on a terminal
error (and on any failed reply to the initial run frame), and `ChatShell.send`
catches it into an `error` row:

```tsx
catch (err) {
  if (err.message === 'TaskQueue cancelled') { /* quiet 'canceled' row → "Stopped" */ }
  else                                       { /* 'error' row: err.message */ }
}
```

The transcript renders an `error` row as a red **"Something went wrong"** block
under that turn, with the server's `message` text (or the code if there was no
message) and a **Try again** button that sends the same prompt again. A
stream event named `error` (an `onStream` frame, not a rejection) lands in the
same block. A turn persisted with `responseType: 'error'` comes back from history
as the same block.

---

## 2. SDK‑level failures (raised by the client, not the server)

### `FatalSendError` — oversized frame, run aborts (does NOT retry)

A frame over `CHAT_SETTINGS.MAX_FRAME_BYTES` (**8 MB**, matching a per‑message size
cap on the Keen server) can never be delivered — it would fail the same way on every
attempt, and a continuation retries with an *infinite* budget, so it would loop
forever. `SendRequest` therefore checks the size up front and throws a
**non‑retryable** `FatalSendError`:

```ts
if (bytes > CHAT_SETTINGS.MAX_FRAME_BYTES) throw new FatalSendError('frame is …MB, over the …MB limit … aborting the run.');
```

`TaskQueue` re‑throws it straight through the drain (never retries it); the run's
one failure boundary then cancels the run's server‑side state and `runFlow()`
rejects with the reason. **Fix by reducing the payload** — a huge dictionary/session
value, an oversized script result, or a giant prompt. (Before this guard existed,
such a frame hung the run in an infinite retry; the guard is why it now fails fast
with a clear message.)

### Cancel — intent, not an error

A user cancel unwinds `runFlow()` by **rejecting with the message
`"TaskQueue cancelled"`**. The app treats that as intent, not failure:

```tsx
if (message === 'TaskQueue cancelled') {
  setMessages(prev => appendCapped(prev, { id, role: 'event', event: 'canceled', text: 'Canceled.', at: Date.now() }));
  return;   // a quiet 'canceled' row, never an error
}
```

The transcript turns that row into a small **"Stopped"** marker under the turn
(whatever the agent had already said stays). A cancel also fires one cancel signal
to the Keen server (wiping the run's state for this connection) and clears local
bundle state. A turn cancelled in an earlier session comes back from history with
the engine's `:: Canceled ::` marker and is shown the same way.

### `waitFor` timeout — a reply never came

`ResponseAPI.waitFor` rejects if no matching reply arrives within
`RESPONSE_TIMEOUT_MS` (**10 min** by default — long enough that a debug pause won't
trip it). Inside `TaskQueue` a timeout on a continuation feeds the (infinite) retry
loop, and on an `initial` **node** it counts against the bounded (10) response
retries — but the initial **run** frame's reply is awaited exactly once: a timeout
there goes straight to the failure boundary and `runFlow()` rejects (the 10‑attempt
budget on the initial run is the *transport* retry in `SendRequest`, not a reply
retry).

### Transport exhaustion — "failed to send after N attempts"

The **initial** run has a **bounded** retry budget (10 attempts). If the socket
never comes up in that window, `SendRequest.execute` resolves
`{ ok: false, error: 'failed to send after N attempts' }`, and `ChatAPI.send`
throws it. (Continuations retry infinitely, so they don't hit this.)

---

## 3. WebSocket close codes (surface via `onSystem`)

A WS close shows up on **`onSystem`** as `close (code <n>)` — never on `onStream`.

- **1006 — abnormal closure.** Most often the page's **Origin is not in Keen's
  allow‑list** — the `origin` of the webhook record bound to a **fully‑bound**
  api_key (client, certificate, consumer contract and webhook record all bound),
  matched exactly (the server drops the upgrade) — or the WS URL / network is
  wrong. On a
  dev deployment it also happens when a `wss://` endpoint's certificate hasn't been
  accepted by the browser yet, and when a `ws://` URL lands on Keen's port 80, which
  only redirects to https (a WebSocket upgrade never follows a redirect — this is
  why the SDK's fallback `ws://localhost/ws-keen` fails). Check: the app is served
  from an allow‑listed origin, the WS URL points at the right host (not `localhost`
  from a second device), and the scheme matches the page (`ws://` on http, `wss://`
  on https — a browser blocks `ws://` from an https page as mixed content). Working
  local values: [`README.md`](README.md), *A local Keen stack*.

- **1009 — message too big.** The standard WebSocket "message too big" close — but
  the relay sets no `maxPayload`, so `ws` only sends it above its default 100 MiB.
  An oversized frame between the 8 MB NATS `max_payload` and that cap is **not**
  closed: it crosses the socket, dies on the relay→engine hop, comes back as an
  `E7…` upstream envelope and, on a continuation, would be retried forever. That
  loop is what the pre‑send size guard (§2, `MAX_FRAME_BYTES`) exists to prevent —
  a well‑behaved client raises a `FatalSendError` up front.

---

## 4. HTTP refusals from the site's own routes (`app/api/*`)

The chat‑management and profile calls (`/api/chat/list`, `/api/chat/history`,
`/api/consumer/profile`, …) are ordinary HTTP through this app's server routes,
and the proxy in front of them answers some refusals itself, always as the same
`{ success: false, status, message }` envelope a handler returns
([`architecture.md`](architecture.md) §4). A failed Keen reply is never passed on
raw: the browser gets Keen's message only when it is a short plain sentence, else
the route's own fallback text.

- **401** — the session token expired / is invalid → **refresh or re‑login**. The
  proxy answers `Session expired. Please sign in again.` for any authenticated
  route (chat, consumer, events, front settings, dictation) when the access token
  no longer verifies. In practice the history/list reads narrow on the envelope's
  `success` flag and simply show empty (a brand‑new chat legitimately has no
  history), while an expired access token is recovered by the refresh path
  (`/api/refresh`). When that fails too, nothing signs the user out on the spot:
  the events loop stops polling on 401 and the next navigation bounces to `/login`
  through the proxy (the forced‑logout event handler fires only on an org webhook).
- **403 `Cross-site request refused.`** — a state‑changing call whose `Origin`
  host is neither `KEEN_ORIGIN`'s nor the requested host. Seen when a page served
  from one host posts to the site under another; serve the pages from the site's
  own origin.
- **429 `Too many attempts…`** with `Retry-After` — the per‑IP rate limit on login,
  OTP, registration, the password legs, refresh and Keen's inbound routes. Users
  behind one NAT share a bucket, and so do all callers when `TRUSTED_PROXY_HOPS`
  doesn't match the proxies in front (see [`README.md`](README.md)). A refused
  `/api/refresh` looks like a failed refresh to the chat: the next send meets
  `E3002`.
- **503 `Keen connection is not ready.`** — a signed‑in call while the connector
  is still booting after the 10 s hold, or after the certificate / contract was
  removed org‑side.
- **503 from `/api/speech-to-text`** — dictation isn't configured
  (`ELEVENLABS_API_KEY` unset); the composer shows the message under the mic.
- **401 on `/api/keen-webhook/<secret>`** — Keen's delivery carried the wrong
  secret: the record's `webhook` URL and `KEEN_WEBHOOK_SECRET` disagree. Keen's
  delivery log shows the status; the certificate never arrives.

---

## Cheat‑sheet

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `E3002` on a send | access token expired | `setAccessToken(fresh)` — socket stays up |
| `E3101` | agent cuid instead of slug; space/agent not authorized; missing `projectId`; **or the contract key was rotated** | slug / space fix — for a rotated contract key the token is stale: **re‑login** (`setAccessToken` from `/api/refresh` won't help) |
| terminal `E2…` (e.g. `E2003`) | bad/duplicate request field | fix the payload; read the envelope `message` |
| `runFlow` rejects on the turn's first reply (e.g. an `E4…` message) | the initial run frame was refused — never retried | send the turn again |
| `E4…` mid‑run | backpressure on a per‑node call | none — SDK retries (10× on an `initial` node, forever on a continuation) |
| a run that never finishes; `E6002` once a second | the run's server‑side state is gone and never comes back | cancel, then send the turn again |
| `runFlow` rejects, "…over the …MB limit" (`FatalSendError`) | frame > 8 MB | shrink the payload (dictionary/session/script result/prompt) |
| `runFlow` rejects, "TaskQueue cancelled" | user cancelled | expected — the app shows a quiet "Stopped" marker |
| `onSystem` "close (code 1006)" | origin not allow‑listed (the `origin` of the record bound to a fully‑bound api_key) / wrong WS URL or scheme / unset `KEEN_WS` | fix the record's origin / URL / ws‑vs‑wss |
| `onSystem` "close (code 1009)" | a frame above the relay's own `ws` cap (default 100 MiB) | shrink the payload; an 8 MB–100 MiB frame fails as `E7…` instead (see §3) |
| HTTP 401 on `/api/chat/*` or `/api/consumer/*` | session expired | refresh or re‑login |
| HTTP 403 "Cross-site request refused." | a write posted from another host | serve the pages from the site's own origin |
| HTTP 429 "Too many attempts…" | per‑IP rate limit | wait `Retry-After` seconds |
| HTTP 503 "Keen connection is not ready." | connector booting / certificate or contract removed | wait for the boot; after a removal, WAKE |
| site stuck on `/maintenance`, Keen's log shows the webhook answered 401 / 404 | wrong secret in the record's `webhook` URL / the bare `/api/keen-webhook` path | register `<site>/api/keen-webhook/<KEEN_WEBHOOK_SECRET>` |
