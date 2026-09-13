# entanglement — the browser app that consumes your Keen agents

**entanglement** is a reference / boilerplate website. It is the starting point a
Keen customer's developers copy to embed a Keen agent **chat** — plus consumer
account management (sign‑up, login, profile, password) — into their own product.

You are (probably) a flow‑building agent. You author the flows that run *behind*
this app: an end user types into the chat here, your flow runs on the Keen server,
and the answer streams back into a bubble on this page. These docs explain the
browser side of that loop so you can integrate a flow, test it against a real UI,
and reason about what the user actually sees when your flow succeeds, stalls, or
fails.

What entanglement is, in one line: **the BROWSER consumer of the Keen ChatSDK.**
The ChatSDK is a small, self‑contained TypeScript client (it lives in
`src/service/services/chat/`, written with zero project imports so it can be
lifted into its own package). entanglement wires that SDK into a Next.js site;
a *copy* of the same SDK also runs headless in the sibling `agent-runner` CLI
(`Keen Mastering/agent-runner/run.ts`), so nothing about it is browser‑specific.
For a headless caller the SDK also ships `KeenChat` (`chat/keen-chat.ts`), a
minimal `{ ws, token, email }` connector — see [`chat-sdk.md`](chat-sdk.md) §1.

---

## Stack

- **Next.js 16** (App Router) + **React 19**
- **Chakra UI v3** for components
- **react-hook-form + zod** for forms
- **jose** for verifying the consumer's session token
- A server‑only **Keen connector** (`src/service/services/keen/`) that holds the
  partner credentials and talks to the Keen HTTP API.

---

## Configure (before the first `npm run dev`)

The Keen connector reads its credentials from the environment at boot and
**throws** if any is missing (`src/service/services/keen/keen.ts` →
`readKeenConfig()`). Copy `.env.example` to `.env.local` and fill in:

| Var | Required | What it is |
|-----|----------|------------|
| `KEEN_HOST` | yes | The Keen edge base URL (dev: `https://localhost`). Every connector call goes to `${KEEN_HOST}/keen-api/*`. |
| `KEEN_ORIGIN` | yes | This app's public origin, an **exact** `scheme://host[:port]`. It is sent as the `Origin` header on every connector call and must be allow‑listed on the Keen api_key, or the relay's OriginGuard silently drops the connection. It is also the base of every email link (`/confirmation/<hash>`, `/set-password/<hash>`, `/confirm-password/<hash>`). |
| `KEEN_CLIENT_ID` / `KEEN_CLIENT_SECRET` | yes | The partner client bound to the api_key. |
| `KEEN_API_KEY_ID` / `KEEN_API_KEY_SECRET` | yes | The api_key id (a cuid) + its secret. |
| `KEEN_WS` | no | The relay WebSocket endpoint the browser connects to (`wss://<host>/ws-keen`; `ws://` only on plain http). **If unset the ChatSDK silently falls back to `CHAT_SETTINGS.WS_URL` (`ws://localhost/ws-keen`)** — fine on the dev box, a 1006 close from any other device or an https page. |

Never put these under `NEXT_PUBLIC_` or in `next.config` — both would inline the
secrets into the client bundle.

- Dev against a self‑signed Keen edge: `npm run dev-local` (sets
  `NODE_TLS_REJECT_UNAUTHORIZED=0` so Node accepts the cert).
- What the connector actually calls, through the nginx edge (`/keen-api/*` →
  ms-client-api `/v1/*`, `/ws-keen` → ms-relay `/ws`):
  `POST /keen-api/auth/application_token`, `GET` + `POST /keen-api/resources/certificate`
  (claim + redeem a one‑time code; the certificate itself arrives on the `r_cert`
  webhook — see [`architecture.md`](architecture.md) §5), `GET /keen-api/space/list`,
  `GET /keen-api/resources/consumer-contract|consumer-policy|agent-front-settings`,
  and the `/keen-api/auth/*` + `/keen-api/consumer/*` legs behind the `app/api/*`
  routes.
- Until the application token **and** the certificate are in hand (`isReady`),
  the proxy sends every page to `/maintenance`; a ready connector whose api_key has
  no consumer contract bound shows "We are a little busy at the moment" on the
  guest pages instead (`checkPageAvailability`).

---

## Folder map

```
src/
├── app/                      Next App Router
│   ├── (app)/                AUTHENTICATED area (chat, spaces, /user account)
│   ├── (login)/              GUEST area (login, reset-password, set-password)
│   ├── (registration)/       GUEST area (register, /confirmation/[hash])
│   ├── (maintanance)/        shown when the Keen connector isn't ready
│   ├── (not-found)/          catch-all 404
│   ├── api/                  SERVER routes that proxy to the Keen server
│   │                         (login, refresh, chat/*, consumer/*, events, webhook…)
│   └── layout.tsx            root layout (theme provider)
│
├── components/
│   ├── ui-chat/              the chat UI: chat-shell, chat-messages, chat-prompt
│   └── ui/                   shared shell (header, footer, dialogs, cards)
│
├── contexts/                 React contexts seeded from the server
│   ├── auth/                 signed-in identity + token refresh
│   ├── consumer/             spaces / agents / chat methods
│   ├── events/               the org→site long-poll RECEIVER + its handlers
│   └── notice/               the one blocking notice dialog
│
├── service/
│   ├── services/chat/        THE ChatSDK — connect, response, send-request,
│   │                         task-queue, index (ChatAPI), settings, utils
│   ├── services/keen/        server-only connector to the Keen HTTP API
│   └── events/event-bus.ts   in-memory bus behind the long-poll channel
│
├── proxy.ts                  runs on every request: session gate + route guards
├── @types/                   ambient types (App.Chat.*, App.ChatUI.*, App.Events.*)
└── @schema/                  zod schemas shared by forms and their API routes
```

---

## How the pieces fit (one paragraph)

A page under `(app)` is built server‑first: the route's **layout** reads the
signed‑in consumer once on the server (through the Keen connector, which is the
only thing that can read the httpOnly session cookies), seeds the **React
contexts** with that identity + the consumer's spaces and agents, and renders the
tree. Inside the chat page, the **ChatShell** component constructs a **ChatAPI**
(the ChatSDK front door), opens a WebSocket to the Keen server, and turns each
user prompt into a `runFlow()` call; the agent's answer streams back through the
SDK's `onStream` callback into a chat bubble. Everything the browser can't do
itself — anything needing the partner credentials or the httpOnly tokens — goes
through this app's own **`app/api/*`** routes, which run on the server and relay
to the **Keen HTTP API**. Separately from the chat, entanglement runs an
org→site **events** channel (a long poll) so the Keen organization can push a
forced logout or a "space changed" notice into an open browser.

---

## Read next

| File | What it covers |
|------|----------------|
| [`architecture.md`](architecture.md) | The layers: route groups, the layer stack, server‑seeded identity, and the `app/api/*` proxy routes. Also the separate org→site events channel. |
| [`pages.md`](pages.md) | Every page — guest (login/register/confirm/reset) and app (chat shell + `/user` account) — what it does, its guard, and the flow it drives. |
| [`chat-sdk.md`](chat-sdk.md) | The five SDK layers and how to USE them — including the exact ChatShell instantiation pattern and `runFlow({chatId, prompt})`. |
| [`callbacks.md`](callbacks.md) | `onStream` vs `onSystem` vs `onStatus` vs `onRunning` vs `onWelcome` — signatures, what fires each, and what the app does with it. |
| [`errors.md`](errors.md) | The error taxonomy: `E….` status codes and their prefix/retry contract, the SDK‑level failures (`FatalSendError`, cancel, timeouts), WebSocket close codes (1006 / 1009), and HTTP 401. |
| [`cookies.md`](cookies.md) | How request cookies reach a flow's **script nodes** — the two `cookies` shapes (names vs explicit map) and the path to `system/cookies`. |
