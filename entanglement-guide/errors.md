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
| `E4…` | **capacity / backpressure** | **retried** on a per‑node call, 1 s apart (an `initial` node at most 10 times, every other node without a limit); on the run frame (first prompt) **not** retried — `runFlow` rejects at once |
| `E5…` | resource | retried on a per‑node call |
| `E6…` | system | retried on a per‑node call |
| `E7…` | upstream | retried on a per‑node call |
| `E8…` | **explicit cancellation** | **terminal** — surfaced |

This split applies to the **per‑node calls** that follow the first reply: a
non‑terminal code is re‑issued 1 s later — at most 10 times for a node marked
`initial` (then `runFlow` rejects `max response retries exceeded for node <id>;
last error: <code>: <message>`), forever for every other node — while `E2…` /
`E3…` / `E8…` end the run at once.

The **run frame** (the turn's first frame, the one carrying the prompt) is not
retried on its reply: any non‑success — `E4…` included — makes `runFlow()` reject
with the server's message. For an `E4…` tell the user the server is busy and to
send the turn again in a minute. (The 15.3 SDK re‑sends an `E4…` refusal of the
run frame 10 × 1 s first — [`chat-sdk.md`](chat-sdk.md) §8.)

### The common codes you can rely on

These are the ones actually referenced in the client; the **precise code and text
always come from the Keen server in the envelope `message`** — don't hard‑code an
exhaustive list.

- **`E3002` — invalid / expired token.** The Keen server verifies the access token
  on *every* run frame and rejects an expired one with `E3002` **without closing the
  socket** (the connection's lifetime is bound to its correlationID, not the token).
  It is terminal for this SDK: the turn fails with `Invalid token`. Recovery:
  refresh the token and apply it with `setAccessToken()` — the next send succeeds,
  no reconnect. entanglement does this every 5 minutes via `/api/refresh` +
  `checkAndRefreshToken()`; with Keen 15.3's 10‑minute access token a turn can
  still meet an expired token for up to ~5 minutes before the next tick
  ([`chat-sdk.md`](chat-sdk.md) §4). On Keen 15.3 `E3002` also answers the token of
  a **revoked** session before it expires (the user signs in again), and names a
  mismatch: `userContext.userId does not match token subject` /
  `userContext.email does not match token e-mail`.

- **`E3101` — the relay's authorization class.** The overwhelmingly common cause is
  **passing the agent's row id (a cuid) instead of its slug** (`agentId`). Construct
  `ChatAPI` with the slug. The relay raises it, in this order, when:
  `chatContext.projectId` is missing; the space isn't in the token's `space` claim;
  the space isn't in the consumer contract's *current* spaces; **the consumer
  contract key was rotated org‑side** (the token's `consumerContractKey` claim no
  longer matches — the token is stale and only a **re‑login** fixes it, since
  `/api/refresh` re‑mints the same stale key); or the agent slug isn't an active
  agent of that space (removed / disabled org‑side).

- **`E2…` — a bad or missing request field** (the client‑error class), e.g.
  **`E2001`** (`missing requestId`, `payload.flowContext.correlationId does not
  match connection cid`). The specific reason arrives in the envelope `message`.

- **`E2101` — the prompt is too long** (Keen 15.3). The relay refuses a run frame
  whose prompt is longer than **20 000 characters** (`.length`, UTF‑16 units, one
  limit for the whole platform): `The message is too long (at most 20000
  characters).`, or `The message must be text.` for a non‑string. Nothing runs.
  Only the user's prompt is limited, not the prompts a flow sets itself. This site
  version has no counter and no limit in its composer: the refusal shows as the
  turn's error block. The welcome frame announces the limit as
  `limits.promptChars`; the 15.3 SDK reads it (`getPromptLimit()`, §8 of
  [`chat-sdk.md`](chat-sdk.md)).

- **`E4001` on the run frame — the account's limits** (Keen 15.3): `too many
  prompts running for this account` (8 started flows at once per consumer) and
  `too many prompts this minute for this account` (60 a minute, the reply carries
  `retryAfterMs`); `account blocked for new prompts` after a flood. This SDK
  rejects the turn at once with that text.

- **`E8101` — a script ran out of time** (Keen 15.3). One script run may take at
  most 15 minutes; then the engine aborts it with `Script time limit reached!`.
  It is terminal (an `E8…`): the turn fails. The limit is per script run, never
  per flow.

You may also see **`E6002`** with the engine text `Dictionary/Session <id> not
found; flow may be cancelled or stale` — a run's server‑side state was gone when a
later frame arrived (after a cancel, or the 60 s state TTL passed). It's in the
`E6` class, so the SDK retries it rather than failing outright — and on a
continuation that retry is **infinite** (once a second) until the user cancels, so a
stale flow does not fail by itself. The state never comes back, so those retries
cannot succeed: the turn just looks stuck. Recover by cancelling (`cancel()`, the
chat's Stop button) and sending the turn again. An `initial` node gives up after
10 tries (`max response retries exceeded …`).

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
`RESPONSE_TIMEOUT_MS` (**10 min** by default). Inside `TaskQueue` a timeout on a
node feeds its retry loop (an `initial` node at most 10 times, any other without a
limit) and the node is re‑sent **as a new request** — on the initial **run** frame
a timeout goes straight to the failure boundary and `runFlow()` rejects. Keen 15.3
lets one script run take up to 15 minutes, so a script node that runs longer than
10 minutes is re‑sent by this SDK while the first run still goes on, and the script
runs twice. Keep script nodes well under 10 minutes for this site version.

### A dropped socket — the turn looks stuck

This SDK does not reconnect ([`chat-sdk.md`](chat-sdk.md) §5): after a close the
status stays `disconnected`, and a running turn keeps waiting until the user
presses **Stop** (`TaskQueue cancelled`). Reload and send the turn again. The 15.3
SDK reconnects and resumes the turn instead, and fails it only with
`connection lost — the server no longer holds this flow` or
`connection taken over by another session` ([`chat-sdk.md`](chat-sdk.md) §8).

### Transport exhaustion — "failed to send after N attempts"

The **initial** run (and an `initial` node) has a **bounded** retry budget
(10 attempts, 1 s apart). If the socket isn't open in that window,
`SendRequest.execute` resolves `{ ok: false, error: 'failed to send after N
attempts' }`, and `ChatAPI.send` throws it. (Other nodes retry infinitely, so they
don't hit this.)

---

## 3. WebSocket close codes (surface via `onSystem`)

A WS close shows up on **`onSystem`** as `close (code <n>)` — never on `onStream`.

- **1006 — abnormal closure.** Most often the page's **Origin is not in Keen's
  allow‑list** — the `origin` of the webhook record bound to a **fully‑bound**
  api_key (client, certificate, consumer contract and webhook record all bound),
  matched exactly (the server drops the upgrade) — or the WS URL / network is
  wrong. Keen 15.3 refuses an empty allow‑list too (every origin), and answers an
  upgrade over its connection caps (1 000 open sockets from one client address per
  relay, 5 000 per relay) with HTTP 429 `Too many connections` before the
  WebSocket opens — the browser also reports that as 1006. On a
  dev deployment it also happens when a `wss://` endpoint's certificate hasn't been
  accepted by the browser yet, and when a `ws://` URL lands on Keen's port 80, which
  only redirects to https (a WebSocket upgrade never follows a redirect — this is
  why the SDK's fallback `ws://localhost/ws-keen` fails). Check: the app is served
  from an allow‑listed origin, the WS URL points at the right host (not `localhost`
  from a second device), and the scheme matches the page (`ws://` on http, `wss://`
  on https — a browser blocks `ws://` from an https page as mixed content). Working
  local values: [`README.md`](README.md), *A local Keen stack*.

- **1012 — service restart.** The relay is restarting. Keen 15.3 holds a running
  flow for its resume grace, but this SDK does not reconnect: the chat stays
  `disconnected` until a reload.
- **1009 — message too big.** Keen 15.3's relay accepts frames of at most 8 MiB
  (the NATS `max_payload`) and closes the socket with 1009 above it. The pre‑send
  size guard (§2, `MAX_FRAME_BYTES`) raises a `FatalSendError` before such a frame
  is sent, so a well‑behaved client never meets it.

The 15.3 SDK also meets 1008 (too many refused resumes), 4409 (the flow was
resumed on a newer connection) and its own 4000 (liveness) —
[`agent-runner/docs/SDK-API.md`](../agent-runner/docs/SDK-API.md).

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
| `E3002` on a send | access token expired (or the session was revoked) | `setAccessToken(fresh)` — socket stays up; the site's 5‑minute tick does it, then send again; a revoked session needs a new sign‑in |
| header "Disconnected", `onSystem` "close (code …)", a turn that never ends | the socket dropped; this SDK does not reconnect | Stop, reload, send the turn again |
| `E2101` "The message is too long (at most 20000 characters)." | the prompt is over the platform limit | shorten the prompt |
| `E4001` "too many prompts … for this account" | 8 running at once, or 60 a minute, for this consumer | wait, then send again |
| `E8101` "Script time limit reached!" | a script run took 15 minutes | make the script shorter |
| `E3101` | agent cuid instead of slug; space/agent not authorized; missing `projectId`; **or the contract key was rotated** | slug / space fix — for a rotated contract key the token is stale: **re‑login** (`setAccessToken` from `/api/refresh` won't help) |
| terminal `E2…` (e.g. `E2001`) | bad/missing request field | fix the payload; read the envelope `message` |
| `runFlow` rejects on the turn's first reply (e.g. an `E4…` message) | the run frame was refused — the server is busy; the flow never started | send the turn again in a minute |
| `E4…` mid‑run | backpressure on a per‑node call | none — the SDK retries the node 1 s apart (an `initial` node 10 times); only a cancel ends a started flow |
| a run that never finishes; `E6002` once a second | the run's server‑side state is gone and never comes back | cancel, then send the turn again |
| `runFlow` rejects, "…over the …MB limit" (`FatalSendError`) | frame > 8 MB | shrink the payload (dictionary/session/script result/prompt) |
| `runFlow` rejects, "TaskQueue cancelled" | user cancelled | expected — the app shows a quiet "Stopped" marker |
| `onSystem` "close (code 1006)" | origin not allow‑listed (the `origin` of the record bound to a fully‑bound api_key) / wrong WS URL or scheme / unset `KEEN_WS` / the per‑address connection cap (429) | fix the record's origin / URL / ws‑vs‑wss |
| `onSystem` "close (code 1009)" | a frame above the relay's 8 MiB cap | shrink the payload (the SDK's own guard normally stops it first, §2) |
| HTTP 401 on `/api/chat/*` or `/api/consumer/*` | session expired | refresh or re‑login |
| HTTP 403 "Cross-site request refused." | a write posted from another host | serve the pages from the site's own origin |
| HTTP 429 "Too many attempts…" | per‑IP rate limit | wait `Retry-After` seconds |
| HTTP 503 "Keen connection is not ready." | connector booting / certificate or contract removed | wait for the boot; after a removal, WAKE |
| site stuck on `/maintenance`, Keen's log shows the webhook answered 401 / 404 | wrong secret in the record's `webhook` URL / the bare `/api/keen-webhook` path | register `<site>/api/keen-webhook/<KEEN_WEBHOOK_SECRET>` |
| site stuck on `/maintenance`, Keen's log shows `E_OUT_SCHEME` / `E_OUT_SSRF` / `E_OUT_REDIRECT` | the `webhook` URL is `http://`, points at a private / internal address, or answers a redirect | an `https://` URL on a public address that answers the POST itself (README, *A local Keen stack*) |
