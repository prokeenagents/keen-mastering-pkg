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
| `(app)` | **authenticated** | `/` (spaces), `/space/[id]/…` (agents → chats → chat), `/user` (account), `/confirm-password/[hash]` |
| `(login)` | guest | `/login`, `/reset-password`, `/set-password/[hash]` |
| `(registration)` | guest | `/registration`, `/confirmation/[hash]` |
| `(maintanance)` | either | `/maintenance` — shown while the Keen connector isn't ready |
| `(not-found)` | either | catch‑all 404 |

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

- **Pages** — a signed‑out visitor hitting an `(app)` page is redirected to
  `/login`. A signed‑in visitor is **not** bounced off the guest pages:
  `proxy-page-auth.ts` lets `/login`, `/registration`, `/reset-password` and the
  hash landings through (its redirect‑to‑`/` branch is unreachable), so only the
  maintenance redirects apply to a live session.
  Email‑link landing pages (`/set-password/<hash>`, `/confirmation/<hash>`) are
  allowed by prefix so their hash segment doesn't 404.
- **API routes** — the proxy allow‑lists API paths (see §4). A path not listed is
  404'd; the authenticated chat/consumer routes are unreachable while signed out.
- If the Keen connector isn't ready yet, both page guards send the visitor to
  `/maintenance`.

---

## 2. The layer stack

A chat page is assembled from five layers, outermost to innermost:

```
Pages / UI components         ← src/app/**, src/components/**
        │  (read contexts, render Chakra)
React contexts                ← src/contexts/**  (auth, consumer, events, notice)
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
const consumerData = await keen.tools.getConsumerData();   // server-only
return (
  <AuthProvider value={consumerData.tokenPayload}>       {/* mutable identity */}
    <ConsumerProvider value={consumerData}>              {/* spaces / agents / chat */}
      <NoticeProvider>                                    {/* the blocking dialog */}
        <EventsProvider>{children}</EventsProvider>       {/* org→site long poll */}
      </NoticeProvider>
    </ConsumerProvider>
  </AuthProvider>
);
```

`getConsumerData()` returns one bundle (`Keen.ConsumerData`) — the raw cookie
tokens (`accessToken`, `refreshToken`), the decoded token payload, the spaces the
consumer is entitled to (the cached space list ∩ the token's `space` claim), every
agent across those spaces, and `wsUrl` (from `KEEN_WS`).
Provider order matters: `NoticeProvider` sits **above** `EventsProvider` because
the events loop hands `notice.show` to its handlers, so the dialog must already be
mounted.

**Step 2 — a server page reads server‑only data and passes it down as props.**
E.g. the chat page reads `consumerData` on the server and hands it to a client
`Content` component, which mounts the chat UI:

```tsx
// src/app/(app)/space/[id]/[agentID]/[chatID]/page.tsx
const consumerData = await getKeen().tools.getConsumerData();
return <Content spaceID={id} agentID={agentID} chatID={chatID} consumerData={consumerData} />;
```

**Step 3 — client components read contexts / hooks.** `'use client'` components
call `useConsumer()`, `useAuth()`, `useChat()` etc. — no server round‑trip, no
re‑fetch. This is why home/space/agent list pages have a server `page.tsx` (reads
the spaces) plus a `content.tsx` marked `'use client'` (renders them).

### The contexts

| Context | Hook | Holds |
|---------|------|-------|
| `auth` | `useAuth()` | the signed‑in `identity` (token payload), an optimistic `updateIdentity`, and `checkAndRefreshToken()` (rotate the session via `/api/refresh`). |
| `consumer` | `useConsumer()` | the server snapshot (`Keen.ConsumerData`: `consumerSpaces`, `agents`, `wsUrl`, `tokenPayload` — and the raw `accessToken` / `refreshToken`, see §4) **plus** chat‑management methods (`chat.list/history/search/setTitle/delete`) that call `/api/chat/*`. |
| `events` | `useEvents()` | the org→site long‑poll receiver; `subscribe(handler)` to react to a push. |
| `notice` | `useNotice()` | `show(notice)` — raise the one blocking dialog from anywhere (even a non‑component). |

The **ChatShell** (a sixth, feature‑scoped context under `components/ui-chat`)
owns the live `ChatAPI` and the conversation for one thread — see
[`chat-sdk.md`](chat-sdk.md).

---

## 4. The server‑side `app/api/*` routes (the proxy layer)

These are Next route handlers that run **on the server** (`runtime = 'nodejs'`) so
they can reach the connector singleton and the httpOnly cookies. They are the only
things that see the partner credentials; the browser only ever sees these local
URLs. The raw session tokens are a different story: browser JS can never read the
httpOnly *cookies*, but `getConsumerData()` returns `accessToken` + `refreshToken`
and the `(app)` layout hands that whole bundle to the client‑side
`ConsumerProvider`, so both tokens are in the client bundle. The access token is
needed there (it stamps every WS frame); the refresh token is not — the provider's
own comment recommends stripping it in the layout.

**Auth / session**

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/login` | POST | Drive consumer login; on success set httpOnly session cookies (the tokens are **not** echoed to the browser). OTP challenges pass through with `isToken:false`. |
| `/api/otp` | POST | Confirm the one‑time code and finish login. |
| `/api/refresh` | POST | Rotate the session; **returns** the fresh access token in the body (the browser needs it to stamp WS frames). See [`errors.md`](errors.md) on `E3002`. |
| `/api/logout` | POST | Expire the session cookies (the browser can't — they're httpOnly). |

**Registration / password (claim + email‑link redeem)**

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/registration` | POST | Claim leg of sign‑up — Keen emails a verification link; nothing is created until the link is followed. |
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

**Server→client + org→site (see §5)**

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/events` | GET | The long‑poll the browser holds open to receive pushes. |
| `/api/keen-webhook` | POST | Receiver for org→site webhooks (a consumer/space/agent changed org‑side). |
| `/api/keen-callback` | POST | Stub receiver for consumer self‑service completion callbacks (Keen POSTs `{ action, consumer, apikeyID, contractKey }` to whatever `X-Callback-Url` a redeem/update carried). entanglement does **not** pass a `callbackUrl` on any redeem/update today, so this route only logs; wire it by passing `callbackUrl` to the connector's redeem / `update` calls. |

The chat/consumer routes are registered in `AUTH_API_CONFIG`; the proxy 404s any
`/api/*` not listed there, and paths are kept **flat** because the allow‑list is an
exact match (ids/filters ride query params or the body, never a dynamic segment).
Three routes bypass the allow‑list entirely — `/api/keen-webhook`,
`/api/keen-callback` and `/api/logout` are passed straight through, so Keen can
reach the receiver and a user can sign out while Keen is down — and, for a
signed‑in caller, every other `/api/*` answers **503** ("Keen connection is not
ready.") until the connector is ready.

---

## 5. The org→site events channel (separate from the ChatSDK)

Independently of chat, entanglement lets the **Keen organization** push changes
into an open browser. This is a plain long poll + an in‑memory bus — it has
**nothing to do with the ChatSDK**.

```
Keen org  ──webhook──▶  POST /api/keen-webhook  ──publish──▶  EventBus
                                                                 │
browser holds GET /api/events open ◀── woken by the bus ─────────┘
        │
   contexts/events → handler (logout / space-change / …)
```

- **`/api/keen-webhook`** receives every org→site webhook. The body is
  `{ 'synch-data': <kind> | [<kinds>], result?, consumer?: { id } }` and the
  receiver handles two families:
  - **Connector lifecycle** (no browser event is published):
    - `r_cert` — the one kind that arrives as a **single string**, with
      `result: { cert, key }` (the public PEM + the shared AES secret). It is the
      only channel that ever delivers `key`; the receiver calls
      `setCertificate(cert, key)`. Without it the connector never becomes
      `isReady` and every page stays on `/maintenance`. (`r_cert` inside an
      array re‑runs the certificate claim/redeem; `r_cert_delete` clears it.)
    - `r_api_keys` — the api_key changed → a full `reconnect()`.
    - `r_consumer_policy` — re‑fetch the consumer contract **and** the live
      policy; `r_consumer_policy_delete` — clear both and deactivate.
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
- **`EventsProvider`** runs that poll loop for the whole session and dispatches
  each event to a handler in `contexts/events/handlers/`:
  - **`logout`** — the account was removed / re‑auth is required: sign the user
    out and redirect to `/login`.
  - **`space-change`** / **`agent-front-settings-change`** — raise a blocking
    notice dialog (dismiss only via X / OK); the page data is refreshed on the
    connector before the notice fires.

The bus is a per‑process, in‑memory singleton — correct for a single‑node
self‑hosted deployment; scaling out would require a shared pub/sub behind it.

> Why a forced logout rather than a silent refresh on a space/entitlement change:
> a consumer's entitlements live in the session token, so only a fresh login
> re‑mints them. `space-change` therefore just *notifies*; the Keen server stays
> the authority on what a given consumer may actually see on the next render.
