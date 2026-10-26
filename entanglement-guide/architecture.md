# Architecture

How entanglement is built, top to bottom: the App Router route groups, the layer
stack a page is made of, how identity is seeded on the server and read on the
client, the server‑side `app/api/*` routes that relay to the Keen server, and the
separate org→site events channel.

---

## 1. Route groups (the levels)

Next App Router groups routes with `(parenthesised)` folders — a group is a URL
namespace with its **own layout**. entanglement splits the site into an
authenticated area and several guest areas:

| Group | Gated? | Contains |
|-------|--------|----------|
| `(app)` | **authenticated** | `/` (home: recent chats + spaces), `/space/[id]/…` (agents → chats → chat), `/user` (account), `/confirm-password/[hash]` — all inside the app shell (sidebar) |
| `(login)` | guest | `/login`, `/reset-password`, `/set-password/[hash]` |
| `(registration)` | guest | `/registration`, `/confirmation/[hash]` |
| `(maintanance)` | either | `/maintenance` — shown while the Keen connector isn't ready |
| `global-not-found.tsx` | signed‑in | a real HTTP 404 for unmatched URLs (a signed‑out visitor is sent to `/login` before any route matches) |

The gate is **`src/proxy.ts`**, which Next runs on every request. It reads the
httpOnly session cookies, classifies the request as `authorized` /
`authenticated` (via `checkLogin` in `utils/auth.ts`, verifying the tokens'
signatures with the public key the connector imported from Keen), and dispatches:

```ts
// src/proxy.ts
const loginStatus = await checkLogin(request);
if (pathname.startsWith('/api/')) return proxyApi(request, loginStatus, pathname);
else                              return proxyPage(request, loginStatus, pathname);
```

- **Pages** — a signed‑out visitor hitting any URL that isn't a guest page (an
  `(app)` page, an unknown path) is redirected to `/login`. A signed‑in visitor is
  **not** bounced off the guest pages:
  `proxy-page-auth.ts` lets `/login`, `/registration`, `/reset-password` and the
  hash landings through (its redirect‑to‑`/` branch is unreachable), so only the
  maintenance redirects apply to a live session.
  Email‑link landing pages (`/set-password/<hash>`, `/confirmation/<hash>`) are
  allowed by prefix so their hash segment doesn't 404.
- **API routes** — the proxy first refuses cross‑site writes and rate‑limits, then
  allow‑lists API paths (see §4). A path not listed is 404'd; a signed‑out caller
  of an authenticated chat/consumer route gets 401.
- If the Keen connector hasn't finished booting, both page guards hold the request
  up to 10 s (a cold start), then send the visitor to `/maintenance`; once the
  connector has booted but isn't ready (contract or certificate removed) the
  redirect is immediate (`waitForAppReady`, `utils/demo.ts`).

---

## 2. The layer stack

A chat page is assembled from five layers, outermost to innermost:

```
Pages / UI components         ← src/app/**, src/components/**
        │  (read contexts, render Chakra)
React contexts                ← src/contexts/**  (auth, consumer, chat-list, events, notice)
        │  (seeded from the server, expose hooks)
The ChatSDK  (ChatAPI)        ← src/service/services/chat/**
        │  (WebSocket transport + flow state machine)
The Keen server               ← WebSocket for chat, HTTP for everything else
        ▲
Keen connector (server-only)  ← src/service/services/keen/**
        │  (holds partner credentials; app/api/* routes call it)
```

Two distinct transports reach the Keen server:

- **Chat** rides a **WebSocket**, opened by the ChatSDK directly from the browser.
- **Everything else** (login, refresh, chat history, profile, …) rides **HTTP**,
  but the browser never calls the Keen HTTP API directly — it calls this app's own
  `app/api/*` routes, which hold the partner credentials and the httpOnly tokens
  and relay onward.

---

## 3. How a page is built (server → client)

Pages under `(app)` are **server‑first**. Identity comes from the server because
the Keen connector and the httpOnly cookies only exist there.

**Step 1 — the layout seeds identity.** `(app)/layout.tsx` runs on the server,
reads the consumer once, and wraps the tree in the context providers:

```tsx
// src/app/(app)/layout.tsx  (abridged)
export const dynamic = 'force-dynamic';                     // never prerendered at build
const consumerData = await keen.tools.getConsumerData();   // server-only
const chatList = await readChatList(keen, consumerData);   // two-token getChatList
return (
  <AuthProvider value={consumerData.tokenPayload}>        {/* mutable identity */}
    <ConsumerProvider value={consumerData}>               {/* spaces / agents / chat */}
      <ChatListProvider initial={chatList}>               {/* the conversation list */}
        <NoticeProvider>                                   {/* the blocking dialog */}
          <EventsProvider>{children}</EventsProvider>      {/* org→site long poll */}
        </NoticeProvider>
      </ChatListProvider>
    </ConsumerProvider>
  </AuthProvider>
);   // {children} is the page wrapped in <AppShell> (sidebar), plus a <Toaster>
```

`getConsumerData()` returns one bundle (`Keen.ConsumerData`) — the raw access
token from the cookie (`accessToken`; there is no `refreshToken` field), the
decoded token payload, the spaces the consumer is entitled to (the cached space
list — already narrowed to the api_key's contract — ∩ the token's `space` claim),
every agent across those spaces, and `wsUrl` (from `KEEN_WS`). `ConsumerProvider`
is a client component, so this whole bundle — the access token included — is
serialized to the browser (§4). With `ENTANGLEMENT_DEMO=1` in dev it returns the
fixture consumer instead (`demo: true`).
Provider order matters: `NoticeProvider` sits **above** `EventsProvider` because
the events loop hands `notice.show` to its handlers, so the dialog must already be
mounted.

**Step 2 — a server page reads server‑only data and passes it down as props.**
E.g. the chat page reads `consumerData` on the server and hands it to a client
`Content` component, which mounts the chat UI. Props of a `'use client'` component
are serialized into the page, so what is passed here is no longer server‑only:

```tsx
// src/app/(app)/space/[id]/[agentID]/[chatID]/page.tsx
const consumerData = await getKeen().tools.getConsumerData();
return <Content spaceID={id} agentID={agentID} chatID={chatID} consumerData={consumerData} />;
```

**Step 3 — client components read contexts / hooks.** `'use client'` components
call `useConsumer()`, `useChatList()`, `useAuth()`, `useChat()` etc. — no server
round‑trip, no re‑fetch. This is why the home / space / agent pages have a thin
server `page.tsx` (route params only) plus a `content.tsx` marked `'use client'`
that renders from the contexts.

### The contexts

| Context | Hook | Holds |
|---------|------|-------|
| `auth` | `useAuth()` | the signed‑in `identity` (token payload), an optimistic `updateIdentity`, and `checkAndRefreshToken()` (rotate the session via `/api/refresh`). |
| `consumer` | `useConsumer()` | the server snapshot (`Keen.ConsumerData`: `consumerSpaces`, `agents`, `wsUrl`, `tokenPayload` — and the raw `accessToken`, see §4) **plus** chat‑management methods (`chat.list/history/search/setTitle/delete`) that call `/api/chat/*`. |
| `chat-list` | `useChatList()` | the consumer's conversations, seeded by the layout and shared by the sidebar, the home page and the agent page; each row resolved to its agent, space and link. `refresh()` re‑reads (the chat page calls it when a turn settles, so a new chat appears), `rename` / `remove` apply once the server confirms. |
| `events` | `useEvents()` | the org→site long‑poll receiver; `subscribe(handler)` to react to a push. |
| `notice` | `useNotice()` | `show(notice)` — raise the one blocking dialog from anywhere (even a non‑component). |

The **ChatShell** (a seventh, feature‑scoped context under `components/ui-chat`)
owns the live `ChatAPI` and the conversation for one thread — see
[`chat-sdk.md`](chat-sdk.md).

---

## 4. The server‑side `app/api/*` routes (the proxy layer)

These are Next route handlers that run **on the server** (`runtime = 'nodejs'`) so
they can reach the connector singleton and the httpOnly cookies. They are the only
things that see the partner credentials; the browser only ever sees these local
URLs. Browser JS can never read the httpOnly session *cookies*, but one token
value leaves the server on purpose: `getConsumerData()` (`keen.tools.ts`) returns
the **access** token, and that bundle goes to client components — the `(app)`
layout passes it to the `'use client'` `ConsumerProvider`, and the chat page passes
it as the `consumerData` prop to its client `Content` → `ChatShell`. React
serializes those props into the page's RSC payload, so the access token is readable
by any script on an `(app)` page; ChatShell needs it there to stamp every WS frame.
The **refresh** token never leaves the cookie: `Keen.ConsumerData` has no field for
it, a unit test (`keen.tools.test.ts`) asserts it, and `/api/refresh` reads it
server‑side. An XSS on an `(app)` page can still lift the access token, not the
4‑week refresh token.

Two rules every route follows:

- **Keen's replies are never forwarded raw.** A refusal goes out as
  `{ success, status, message }` through `utils/upstream-reply.ts`
  (`clientEnvelope` / `clientReply` / `publicMessage`): Keen's text only when it is
  a short, plain sentence, else the route's own fallback — Keen errors can carry
  database internals. A successful chat / profile reply passes through as‑is.
- **One rule for new passwords** (`@schema/password.ts`): 8+ characters with an
  upper‑case letter, a lower‑case letter and a digit — for registration, reset and
  change, in the forms and the routes alike. Login only checks that a password is
  present, so older accounts can still sign in.

**Auth / session**

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/login` | POST | Drive consumer login; on success set httpOnly session cookies (the tokens are **not** echoed to the browser). An OTP challenge or a refusal comes back with `isToken:false` — only the OTP hash and a safe message, never Keen's envelope. |
| `/api/otp` | POST | Confirm the one‑time code and finish login. |
| `/api/refresh` | POST | Rotate the session; **returns** the fresh access token in the body (the browser needs it to stamp WS frames). See [`errors.md`](errors.md) on `E3002`. |
| `/api/logout` | POST | Expire the session cookies (the browser can't — they're httpOnly). |

**Registration / password (claim + email‑link redeem)**

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/registration` | POST | Claim leg of sign‑up — Keen emails a verification link; nothing is created until the link is followed. A refusal Keen recognises as an existing account answers 409 with "An account with this email address already exists…". |
| `/api/reset-password` | POST | Claim leg of a logged‑out password reset. |
| `/api/set-password` | POST | Redeem variant for the reset link (the page also redeems server‑side on load). |
| `/api/consumer/reset-password` | POST | Logged‑in password change claim (proof of identity is the live session). |

> Every self‑service leg (this table plus `/api/consumer/update`) is gated on the
> tenant's consumer‑contract policy flag `outsideRegistration`. When it is off the
> Keen edge answers `{ success:false, status:403, message:'Action forbidden.' }`,
> the forms show that as their root error, and nothing is emailed.

**Consumer data / chat management (two‑token, authenticated‑only)**

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/consumer/profile` | GET | Read the caller's editable profile (name / gender / dob) to prefill `/user`. |
| `/api/consumer/update` | POST | Partial profile update. Keen's reply carries **no** new tokens, so the session cookie is **not** re‑minted: the token still holds the old `username` until the next login (the route would refresh the cookies if a token ever came back). |
| `/api/chat/list` | GET | The consumer's chat threads. |
| `/api/chat/history` | GET | One thread's turns (last N; cursor‑paged). |
| `/api/chat/search` | GET | Search the consumer's chats. |
| `/api/chat/title` | POST | Rename a chat. |
| `/api/chat/delete` | POST | Archive a chat — a **soft delete** (Keen sets `archived = true`, never hard‑deletes; there is no erase mode). The chat vanishes from list/search and history refuses it, but the rows are retained. |
| `/api/agent-front-settings` | GET | An agent's partner‑facing "front settings". |
| `/api/speech-to-text` | POST | Dictation: multipart `audio` + `language` (`en` / `bg` / `auto`) → ElevenLabs Scribe → `{ success, text, languageCode }`. 503 when `ELEVENLABS_API_KEY` is unset; 413 above 10 MB. |

**Server→client + org→site (see §5)**

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/events` | GET | The long‑poll the browser holds open to receive pushes. |
| `/api/keen-webhook/<KEEN_WEBHOOK_SECRET>` | POST | Receiver for org→site webhooks (a consumer/space/agent changed org‑side, and the certificate itself). The last path segment is the shared secret: a wrong one gets **401** before the body is read — see §5. The bare `/api/keen-webhook` no longer exists (404). |
| `/api/keen-callback` | POST | Stub receiver for consumer self‑service completion callbacks (Keen POSTs `{ action, consumer, apikeyID, contractKey }` to whatever `X-Callback-Url` a redeem/update carried). entanglement does **not** pass a `callbackUrl` on any redeem/update today, and the route only answers 200 — it never reads or logs the body; wire it by passing `callbackUrl` to the connector's redeem / `update` calls (and authenticate it first: it has no secret). |

What the proxy does with an `/api/*` call, in order (`src/proxy/api/`):

1. **Cross‑site refusal** (`request-guard.ts`). A `POST` / `PUT` / `PATCH` /
   `DELETE` whose `Origin` host is neither `KEEN_ORIGIN`'s host nor the host the
   request was addressed to (`Host` / `X-Forwarded-Host`) gets **403** "Cross-site
   request refused." No `Origin` falls back to `Sec-Fetch-Site: cross-site`; a
   caller sending neither (a server, `curl`) passes. Keen's inbound routes are
   exempt.
2. **Rate limits** (`configs/rate-limit.config.ts`), per client IP
   (`TRUSTED_PROXY_HOPS`, see [`README.md`](README.md)), fixed window, in memory:
   `/api/login` and `/api/otp` 10 a minute; `/api/registration`,
   `/api/reset-password` and `/api/consumer/reset-password` 5 per 15 minutes;
   `/api/set-password` 10 per 15 minutes; `/api/refresh` 30 a minute; the webhook
   and `/api/keen-callback` 60 a minute. Over the limit: **429** "Too many
   attempts…" with `Retry-After`.
3. **Pass‑through** — `/api/keen-webhook/*`, `/api/keen-callback` and
   `/api/logout` go straight to their handlers (no session, no readiness check), so
   Keen can reach the receiver and a user can sign out while Keen is down. The
   webhook checks its own secret.
4. **Signed out** — a guest route (`login`, `otp`, `refresh`, `registration`,
   `reset-password`, `set-password`, `logout`) passes; an authenticated route gets
   **401** "Session expired. Please sign in again."; anything else 404.
5. **Signed in** — the request is held up to 10 s while the connector boots, then
   answers **503** ("Keen connection is not ready.") if it still isn't ready; a
   path not in `API_CONFIG` gets 404.

The chat/consumer routes are registered in `AUTH_API_CONFIG`, and paths are kept
**flat** because the allow‑list is an exact match (ids/filters ride query params
or the body, never a dynamic segment).

---

## 5. The org→site events channel (separate from the ChatSDK)

Independently of chat, entanglement lets the **Keen organization** push changes
into an open browser. This is a plain long poll + an in‑memory bus — it has
**nothing to do with the ChatSDK**.

```
Keen org ──webhook──▶ POST /api/keen-webhook/<secret> ──publish──▶ EventBus
                                                                     │
browser holds GET /api/events open ◀── woken by the bus ─────────────┘
        │
   contexts/events → handler (logout / space-change / …)
```

- **`/api/keen-webhook/<KEEN_WEBHOOK_SECRET>`** receives every org→site webhook
  (`src/app/api/keen-webhook/[secret]/route.ts`). A wrong secret is refused with
  401 before the body is read (see *Who may call the webhook* below); a process
  with no connector at all answers 503. The body is
  `{ 'synch-data': <kind> | [<kinds>], result?, consumer?: { id } }` and the
  receiver handles two families:
  - **Connector lifecycle** (no browser event is published):
    - `r_cert` — the one kind that arrives as a **single string**, with
      `result: { cert, key }` (the public PEM + the shared AES secret). It is the
      only channel that ever delivers `key`. The receiver hands it to
      `acceptCertificate(cert, key)`, which takes it **only within 60 s of a
      certificate redeem this connector started, and only once per redeem**;
      material arriving at any other time is dropped with
      `Unsolicited certificate material ignored`. A certificate with an empty
      `key` is refused (`Certificate REFUSED: it has no shared secret key`).
      Without a certificate the connector never becomes `isReady` and every page
      stays on `/maintenance`. Keen sends `r_cert` on every certificate
      **redeem** — the connector's own boot step (below) — and on a WAKE (where
      it is ignored unless a redeem is outstanding; see *A WAKE in open
      browsers*).
    - `['r_cert']` as an **array** is what Keen sends when a certificate is
      updated (its secret key included) or rotated. The receiver calls
      `refreshCertificate()`: it clears the old code, claims and redeems a fresh
      one, and the new material arrives on the `r_cert` push that redeem
      triggers. The current certificate keeps working until then. One trap: if
      the admin **cleared** the certificate's secret key, the new material is
      refused, but after boot that does not send the site to `/maintenance` —
      the certificate and secret are blanked while the connector stays ready and
      keeps the old verification key, so sessions still pass the proxy yet no
      token payload opens: signed‑in pages render with no identity, no spaces and
      no chat. Keep a secret on the certificate.
    - `r_cert_delete` — clears the certificate and marks the connector inactive
      (every page to `/maintenance`) until the next `reconnect()` (a WAKE) or a
      restart.
    - `r_api_keys` — the api_key changed → `reconnect()`: a new application token
      and a fresh certificate redeem, then the contract / policy / space‑list
      reads. The current token, certificate and secret stay in use until their
      replacements land, so the site stays up meanwhile.
    - `r_consumer_policy` — re‑fetch the consumer contract **and** the live
      policy, then re‑scope the space list to the contract;
      `r_consumer_policy_delete` — clear both and deactivate.
    - `r_json` — re‑fetch the front settings of every cached agent (and publish
      `agent-front-settings-change`, below).

    Keen sends these from ms-api-keys on api_key / certificate / contract
    mutations and, all at once, on an admin **WAKE** (the `r_cert` push followed
    by `['r_api_keys','r_consumer_policy','r_space','r_agent','r_json']`).
  - **Browser events** — the receiver refreshes the connector's cache first, then
    **publishes** an `App.Events.Event` onto the in‑memory `EventBus`
    (`src/service/events/event-bus.ts`): `r_space` / `r_agent` → `space-change`
    (broadcast key); `r_agent_front_settings` / `r_json` →
    `agent-front-settings-change` (broadcast key); and the consumer‑targeted
    `r_consumer_spaces_update` / `r_consumer_contract_changed` (the body carries
    `consumer.id`) → `logout` on that consumer's key. The receiver also accepts
    `r_consumer_logout`, but **nothing on the Keen side emits it today**.
- **`/api/events`** is a `force-dynamic` GET the browser holds open (~25s). It
  parks on the caller's own consumer key **and** the broadcast key; when the bus
  wakes it, it returns the events and the client re‑polls.
- **`EventsProvider`** runs that poll loop for the whole session (re‑poll at once
  on a normal return, 3 s back‑off on an error, stop on 401). It **pauses while
  the tab is hidden**: the held request is aborted and none starts until the tab
  is visible again, which then calls `router.refresh()` first, so the server
  re‑renders spaces, agents and settings from its webhook‑fed cache and covers
  anything broadcast meanwhile. A hidden tab therefore holds no open request (on a
  scale‑to‑zero host an idle site costs nothing). It dispatches each event to a
  handler in `contexts/events/handlers/`:
  - **`logout`** — the account was removed / re‑auth is required: sign the user
    out and redirect to `/login`.
  - **`space-change`** / **`agent-front-settings-change`** — raise a blocking
    notice dialog (dismiss only via X / OK); the page data is refreshed on the
    connector before the notice fires.

The bus is a per‑process, in‑memory singleton — correct for a single‑node
self‑hosted deployment; scaling out would require a shared pub/sub behind it. A
broadcast reaches every browser whose poll is parked at that moment; one that finds
no poll parked is queued, and the first browser to poll next takes it — the others
never see it (a returning hidden tab's refresh covers the data, not the notice). A
targeted event waits in its consumer's queue until that consumer polls; a process
that restarts (or scales to zero) starts with empty queues, so a forced logout
sent meanwhile is lost — the relay still checks the token on every chat frame.

> Why a forced logout rather than a silent refresh on a space/entitlement change:
> a consumer's entitlements live in the session token, so only a fresh login
> re‑mints them. `space-change` therefore just *notifies*; the Keen server stays
> the authority on what a given consumer may actually see on the next render.

### Boot order: how the certificate arrives

`instrumentation.ts` creates the connector when the server starts, and
`connect()` runs three steps, each retried every 2 s until it lands:

1. `POST /keen-api/auth/application_token` — the partner credentials.
2. `GET /keen-api/resources/certificate` — a single‑use code (120 s TTL on Keen).
3. `POST /keen-api/resources/certificate` with that code — the **redeem**. Keen
   checks the code, then ms-api-keys POSTs
   `{ 'synch-data': 'r_cert', result: { cert, key } }` to the `webhook` URL of the
   record bound to the api_key. The redeem's own reply carries no certificate.

The redeem opens the 60 s acceptance window *before* its request goes out, because
Keen may post `r_cert` before the redeem's reply comes back. `tryActivate` then
waits (logging `[BOOT] Application activated: FALSE` every 2 s, but waking the
moment the certificate is stored) until the webhook has delivered it, sets
`isReady`, reads the consumer contract, the policy and the space list, and only
then sets `isActivated` — the flag the proxy's cold‑start hold waits for.

**While no certificate has arrived, the connector redeems a fresh code every
~16 s** (every 8th 2‑s wait). That covers a lost delivery — the one POST failed
(Keen sends it once, 5 s timeout, no retry) or, during a rolling deploy, it landed
on the old instance that still owned the URL — and a certificate refused for having
no secret key: once the admin generates one, the next redeem picks it up. So
neither **a restart nor a lost boot delivery needs a WAKE**. If the `webhook` URL
doesn't reach this site at all (wrong URL or secret, tunnel down), the log shows
the claim and the redeem succeeding every ~16 s and nothing arriving.

### Who may call the webhook: the secret path

Keen does not sign these POSTs — ms-api-keys sends a plain JSON body with only a
`Content-Type` header — so the URL itself is the shared secret:

- The only route is **`POST /api/keen-webhook/<secret>`**. The handler compares the
  segment with `KEEN_WEBHOOK_SECRET` (both sides SHA‑256‑hashed, then a
  constant‑time compare, `src/utils/webhook-secret.ts`) and answers **401**
  `Unauthorized.` on a mismatch, before reading the body. An unset or short
  expected secret rejects everything.
- `readKeenConfig()` refuses to boot without `KEEN_WEBHOOK_SECRET` or with one
  shorter than 32 characters (`openssl rand -hex 32`).
- Register the full URL as the webhook record's `webhook`:
  `<a URL that reaches the site>/api/keen-webhook/<KEEN_WEBHOOK_SECRET>`, the
  secret as the last segment. Keen accepts a path there (only the record's
  `origin` must be a bare `scheme://host[:port]`).
- The proxy passes the path through without a session but rate‑limits it (60 a
  minute per client IP, §4).
- Certificate material is further accepted only inside a redeem window the
  connector opened itself (above), so even a caller holding the secret can't
  swap the verification key at an arbitrary time.

What a holder of the URL can still do: push `r_cert_delete` (the site drops to
`/maintenance`), a consumer‑targeted kind with any `consumer.id` (a forced logout),
cache re‑reads, and a certificate inside a redeem window. Treat the URL as a
credential. It is stored in the Keen admin's webhook record, and it shows up
wherever full request URLs are logged — Keen's ms-api-keys logs the URL on a failed
delivery and on a WAKE, and a hosting platform's request log records the path. If
it leaks, rotate it in both places (env + record). Restricting the path to the Keen
platform's egress addresses adds a second layer.

### A WAKE in open browsers

A WAKE sends two POSTs: the certificate material as a single `r_cert`, and the
array `['r_api_keys','r_consumer_policy','r_space','r_agent','r_json']`. Outside a
redeem window the first is ignored as unsolicited; the array's `r_api_keys` makes
the connector `reconnect()`, whose fresh redeem brings the certificate back by the
regular path. The site stays up throughout: the current certificate and token stay
in use until the new ones land, so pages are not sent to `/maintenance` and
`/api/*` calls don't 503.

The array also carries `r_space`, `r_agent` and `r_json`, so besides re‑filling
the caches it publishes two broadcast events: `space-change` (shown as "Agent
changed", since `r_agent` is in the array) and then `agent-front-settings-change`
("Agent settings updated"). Every signed‑in browser with a parked poll raises the
blocking notice for the first; the second replaces its text if the dialog is still
open (`notice.show` swaps the content of the one dialog) or opens it again if the
user already dismissed it. So a WAKE still interrupts every live user with a
dialog — prefer it on a site nobody is using, or for recovery (after an
`r_cert_delete`, it is what brings the site back).
