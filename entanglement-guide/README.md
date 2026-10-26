# entanglement — the browser app that consumes your Keen agents

**entanglement** is a reference / boilerplate website. It is the starting point a
Keen customer's developers copy to embed a Keen agent **chat** — plus consumer
account management (sign‑up, login, profile, password) — into their own product.

You are (probably) a flow‑building agent. You author the flows that run *behind*
this app: an end user types into the chat here, your flow runs on the Keen server,
and the answer streams back into the conversation on this page. These docs explain the
browser side of that loop so you can integrate a flow, test it against a real UI,
and reason about what the user actually sees when your flow succeeds, stalls, or
fails.

What entanglement is, in one line: **the BROWSER consumer of the Keen ChatSDK.**
The ChatSDK is a small, self‑contained TypeScript client (it lives in
`src/service/services/chat/`, written with zero project imports so it can be
lifted into its own package). entanglement wires that SDK into a Next.js site;
a *copy* of the same SDK (`agent-runner/sdk/`) also runs headless in the sibling
`agent-runner` CLI (`agent-runner/run.ts`), so nothing about it is browser‑specific.
For a headless caller the SDK also ships `KeenChat` (`chat/keen-chat.ts`), a
minimal `{ ws, token, email }` connector — see [`chat-sdk.md`](chat-sdk.md) §1.

---

## Stack

- **Next.js 16** (App Router) + **React 19**
- **Chakra UI v3** for components, themed from `src/theme/` (brand config +
  semantic tokens, dark / light via next-themes)
- **react-markdown + remark-gfm + rehype-highlight** for agent answers (raw HTML
  off)
- **react-hook-form + zod** for forms
- **jose** for verifying the consumer's session token
- **vitest** for the unit tests (`npm test`)
- A server‑only **Keen connector** (`src/service/services/keen/`) that holds the
  partner credentials and talks to the Keen HTTP API.

---

## Configure (before the first `npm run dev`)

The Keen connector reads its credentials from the environment at boot and
**throws** if any is missing (`src/service/services/keen/keen.ts` →
`readKeenConfig()`). In production `instrumentation.ts` then exits the process, so
a host never routes to an instance without its config; in dev it keeps running.
Copy `.env.example` to `.env.local` and fill in:

| Var | Required | What it is |
|-----|----------|------------|
| `KEEN_HOST` | yes | The Keen edge base URL (dev: `https://localhost`). Every connector call goes to `${KEEN_HOST}/keen-api/*`. Must be a full `http(s)://` URL — a bare host fails the boot. |
| `KEEN_ORIGIN` | yes | This app's public origin, an **exact** `scheme://host[:port]` (a full `http(s)://` URL, checked at boot). It is sent as the `Origin` header on every connector call and must equal the `origin` of the **webhook record** bound to the api_key. Keen's allow‑list is the set of those origins across every **fully‑bound** api_key — client, certificate, consumer contract and webhook record all bound (an empty set = any origin); a half‑wired key's origin is not on it. An origin not on the list is dropped silently by Keen's OriginGuard (no HTTP status; a 502 through nginx). Serve the pages from this same origin: the chat WebSocket is checked against the same list. It is also the base of every email link (`/confirmation/<hash>`, `/set-password/<hash>`, `/confirm-password/<hash>`), and the CSRF guard accepts its host (see [`architecture.md`](architecture.md) §4). (The site's own `.env.example` says the origin is "allow‑listed on the Keen api_key"; the record's origin is what counts.) |
| `KEEN_CLIENT_ID` / `KEEN_CLIENT_SECRET` | yes | The partner client bound to the api_key. |
| `KEEN_API_KEY_ID` / `KEEN_API_KEY_SECRET` | yes | The api_key id (a cuid) + its secret. |
| `KEEN_WEBHOOK_SECRET` | yes | The secret path segment of the webhook URL: the record's `webhook` is any URL that reaches the site plus `/api/keen-webhook/<KEEN_WEBHOOK_SECRET>`. At least 32 characters or the boot refuses (`openssl rand -hex 32` gives 64). See [`architecture.md`](architecture.md) §5. |
| `KEEN_WS` | no | The relay WebSocket endpoint the browser connects to (`wss://<host>/ws-keen`; `ws://` only on plain http). **If unset the ChatSDK silently falls back to `CHAT_SETTINGS.WS_URL` (`ws://localhost/ws-keen`)**, which never connects to a Keen nginx edge: its port 80 answers every path but `/healthz` with a 301 to https, and a WebSocket upgrade doesn't follow redirects (close 1006). Always set it — see *A local Keen stack* below. |
| `ELEVENLABS_API_KEY` | no | Server‑only key for dictation (ElevenLabs Scribe). Unset, the mic button still shows, and a recording comes back with the route's 503 "not configured" message. See *Dictation* below. |
| `ELEVENLABS_STT_MODEL` | no | The Scribe model; default `scribe_v2`. |
| `TRUSTED_PROXY_HOPS` | no | How many proxies append to `X-Forwarded-For` in front of the site; the rate limiter keys on the entry that many places from the right. `1` (default) for one proxy (nginx, ngrok, Cloud Run), `2` behind an external HTTPS load balancer. Too high keys on an entry the client chose. With no proxy at all the header is the client's own, or absent (then every caller shares one bucket), so run the site behind one. |
| `ENTANGLEMENT_DEMO` | no | `1` runs the UI on fixture data and a simulated agent, no Keen needed (`ENTANGLEMENT_DEMO=1 npm run dev`). Ignored when `NODE_ENV=production` (`src/utils/demo.ts`), because it treats every visitor as signed in. |

Never put these under `NEXT_PUBLIC_` or in `next.config` — both would inline the
secrets into the client bundle.

- Dev against a self‑signed Keen edge: `npm run dev-local` (sets
  `NODE_TLS_REJECT_UNAUTHORIZED=0` so Node accepts the cert); against a trusted
  cert, `npm run dev`. On Windows use `npm run dev-local:win` / `npm run dev:win`
  (the same through `cross-env`). Every dev script opens the Node inspector on
  `127.0.0.1:3210` (this machine only).
- What the connector actually calls, through the nginx edge (`/keen-api/*` →
  ms-client-api `/v1/*`, `/ws-keen` → ms-relay `/ws`):
  `POST /keen-api/auth/application_token`, `GET` + `POST /keen-api/resources/certificate`
  (claim + redeem a one‑time code; the certificate itself arrives on the `r_cert`
  webhook — see [`architecture.md`](architecture.md) §5), `GET /keen-api/space/list`,
  `GET /keen-api/resources/consumer-contract|consumer-policy|agent-front-settings`,
  and the `/keen-api/auth/*` + `/keen-api/consumer/*` legs behind the `app/api/*`
  routes. The space list comes back org‑wide; the connector keeps only the spaces
  of its own consumer contract, without their `deploymentToken`, before caching it
  (`keen.space-scope.ts`).
- The boot is done when the application token and the certificate are in hand
  (`isReady`) **and** the first contract / policy / space‑list reads have run
  (`isActivated`). Until then the proxy holds each request up to 10 s
  (`waitForAppReady`, `src/utils/demo.ts`), then sends it to `/maintenance`; the
  `/maintenance` page itself answers at once. A ready connector with no consumer
  contract loaded shows a "We're a little busy" card on the guest pages instead
  (`checkPageAvailability`). How the certificate arrives at boot, and when a WAKE
  is still needed: [`architecture.md`](architecture.md) §5.
- The certificate must carry a **shared secret key** (Keen admin → the certificate
  → generate a secret). The connector refuses a certificate without one — at boot
  it stays on `/maintenance`, logging `Certificate REFUSED` — because Keen would
  otherwise seal sessions, OTP and registration hashes with a fixed public default
  key (`keen.crypto.ts` has no fallback key either).

### A local Keen stack — a working browser chat

On a Keen stack running on your own machine the edge is nginx on `https://localhost`
(self‑signed): `/keen-api/*` and `/ws-keen` on :443, while :80 only redirects to
https. A *development* stack also publishes the relay directly as
`ws://localhost:5520/ws` (plain, no TLS); a production‑template stack does not.
Three things are checked separately and must line up:

1. **The webhook record** bound to the api_key has two independent fields: `origin`
   (the allow‑list entry, exact `scheme://host[:port]`) and `webhook` (the URL Keen
   POSTs to). Keen's services run in containers, so `webhook` must be reachable
   *from them* — `http://localhost:3000` there is the container itself, not your
   site. A tunnel to the site
   (`https://<tunnel-host>/api/keen-webhook/<KEEN_WEBHOOK_SECRET>`) works. The bare
   `/api/keen-webhook` no longer exists: a record still pointing there gets 404 and
   the certificate never arrives.
2. **`KEEN_ORIGIN` equals the record's `origin`**, and you open the pages from
   exactly that origin.
3. **`KEEN_WS` matches the page's scheme.**

Two combinations work, both only in a browser on the machine that runs the stack
(in a browser, `localhost` is the viewer's own machine):

| Pages served from (= `origin` = `KEEN_ORIGIN`) | `KEEN_WS` | Note |
|---|---|---|
| `http://localhost:3000` | `ws://localhost:5520/ws` or `wss://localhost/ws-keen` | `webhook` points at a tunnel to the site |
| the tunnel, `https://<tunnel-host>` | `wss://localhost/ws-keen` | `ws://` is blocked on this https page as mixed content |

For the second row under `npm run dev*`, the tunnel's host must be in
`allowedDevOrigins` (`next.config.ts`), which trusts only `*.ngrok-free.app` and
`*.ngrok-free.dev` for Next's dev resources; add any other tunnel host there.

For `wss://localhost/ws-keen`, open `https://localhost` once in the same browser and
accept the self‑signed certificate — until then the socket closes 1006 with no
reason. Never point `KEEN_WS` at a free ngrok tunnel (it answers the upgrade with
503), and don't leave it unset (above). Against a remote Keen host the value is
simply `wss://keen.example.com/ws-keen`.

### Brand and look — `CUSTOMIZING.md`

The UI is token‑driven, and the site ships its own rebranding guide,
**`CUSTOMIZING.md`**; read it rather than editing components. The first file to
touch is **`src/theme/brand.config.ts`**: product name, tagline, "powered by" line,
logo files (served from `public/brand/`), the accent colour scale, the corner‑radius
preset, the default colour mode, and the starter prompts an empty conversation
offers (`BRAND.suggestedPrompts`). Semantic tokens live in `src/theme/tokens.ts`.
The typeface is set in `src/app/layout.tsx`; `src/app/global-not-found.tsx` renders
without the root layout and loads its own font, so a font swap goes in both. Keep
logo files as `.png`: the proxy matcher skips only `.png` paths, so any other
extension under `public/` goes through the session gate and a signed‑out visitor
gets a redirect to `/login` instead of the image.

### Dictation

The composer has a mic button: the person records up to 5 minutes, picks the
language they speak (English or Bulgarian; the choice is remembered), and the
transcript lands in the message box for them to review — it is never sent on its
own. The browser posts the recording to `POST /api/speech-to-text` (signed‑in
only), which calls ElevenLabs Scribe with the server‑only `ELEVENLABS_API_KEY`
(`src/service/speech/scribe.ts`). Without the key the button is still there and
the route answers **503** "Speech-to-text is not configured on this server"; the
rest of the site is unaffected. Dictation is plain HTTP, independent of the chat
socket.

### Production deploy — `DEPLOYING.md`

The site ships a `Dockerfile` (standalone Next server on `node:24-slim`, non‑root,
port 8080, no `.env*` in the image) and `cli/*.sh` for Google Cloud Run with the
secrets in Secret Manager: `cli/config.sh` holds every setting (the scripts refuse
to run on its placeholders), `cli/secrets.sh` pushes the secrets, `cli/deploy.sh`
creates and configures the service (and a custom domain), `cli/redeploy.sh` rolls a
code update. The site's **`DEPLOYING.md`** walks through all of it, including the
Keen side; follow it rather than this summary. What matters to an integrator:

- The required secrets are `KEEN_CLIENT_SECRET`, `KEEN_API_KEY_SECRET` and
  `KEEN_WEBHOOK_SECRET`; `ELEVENLABS_API_KEY` is optional. `deploy.sh` sets
  `KEEN_ORIGIN` itself, to the custom domain or the service's own `run.app` URL.
- **One instance at most.** The connector's token, certificate and caches, the
  webhook → long‑poll event bus and the rate limiter all live in process memory; a
  second instance would get webhooks meant for the first.
- **Scale to zero.** A hidden tab pauses its `/api/events` long poll, so an idle
  site holds no open request; the first visitor after an idle spell is held up to
  10 s while the connector boots.
- On Keen, the webhook record's origin is the site's public origin and its
  `webhook` is `<a URL that reaches the service>/api/keen-webhook/<KEEN_WEBHOOK_SECRET>`.
- Every process started with `NODE_ENV=production` (`next start` or the image)
  exits on missing Keen config, ignores `ENTANGLEMENT_DEMO`, and sets the session
  cookies `Secure` — so serve it over https.

---

## Folder map

```
src/
├── app/                      Next App Router
│   ├── (app)/                AUTHENTICATED area (chat, spaces, /user account)
│   ├── (login)/              GUEST area (login, reset-password, set-password)
│   ├── (registration)/       GUEST area (registration, /confirmation/[hash])
│   ├── (maintanance)/        shown when the Keen connector isn't ready
│   │                         (sic — the folder is spelled so; the URL is /maintenance)
│   ├── api/                  SERVER routes that proxy to the Keen server
│   │                         (login, refresh, chat/*, consumer/*, events,
│   │                         keen-webhook/[secret], speech-to-text…)
│   ├── global-not-found.tsx  the real 404 for unmatched URLs
│   └── layout.tsx            root layout (theme provider, brand font)
│
├── components/
│   ├── ui-chat/              the chat UI: chat-shell, chat-header,
│   │                         chat-messages, chat-prompt (+ dictation)
│   └── ui/                   app-shell (sidebar, user menu), page / status cards,
│                             dialogs, logo, surfaces
│
├── contexts/                 React contexts seeded from the server
│   ├── auth/                 signed-in identity + token refresh
│   ├── consumer/             spaces / agents / chat methods
│   ├── chat-list/            the consumer's conversation list (sidebar, pages)
│   ├── events/               the org→site long-poll RECEIVER + its handlers
│   └── notice/               the one blocking notice dialog
│
├── service/
│   ├── services/chat/        THE ChatSDK — connect, response, send-request,
│   │                         task-queue, index (ChatAPI), keen-chat, settings, utils
│   ├── services/keen/        server-only connector to the Keen HTTP API
│   ├── events/event-bus.ts   in-memory bus behind the long-poll channel
│   ├── rate-limit/           in-memory per-IP limiter used by the proxy
│   └── speech/               ElevenLabs Scribe client (dictation)
│
├── proxy.ts + proxy/         runs on every request: CSRF + rate limits, session
│                             gate, route allow-list, cold-start hold
├── theme/                    brand.config.ts, tokens, the Chakra system
├── demo/                     fixtures + simulated agent (ENTANGLEMENT_DEMO=1)
├── hooks/                    dictation, persistent state, login
├── @types/                   ambient types (App.Chat.*, App.ChatUI.*, App.Events.*)
└── @schema/                  zod schemas shared by forms and their API routes
                              (password.ts = the one new-password rule)
```

---

## How the pieces fit (one paragraph)

A page under `(app)` is built server‑first: the route's **layout** reads the
signed‑in consumer once on the server (through the Keen connector — browser JS
can't read the httpOnly session cookies), seeds the **React contexts** with that
identity + the consumer's spaces, agents and conversation list, and renders the
tree inside the app shell (sidebar + page). The seeded bundle also carries the raw
**access** token value — the chat socket stamps it on every frame — so it reaches
client JavaScript despite the httpOnly cookie; the refresh token does not (see
[`architecture.md`](architecture.md) §4). Inside the chat page, the **ChatShell** component constructs a **ChatAPI**
(the ChatSDK front door), opens a WebSocket to the Keen server, and turns each
user prompt into a `runFlow()` call; the agent's output streams back through the
SDK's `onStream` callback, and the transcript folds it into one turn per prompt —
the steps (events, tool calls) in a collapsible trace, the final answer as
markdown. Everything the browser can't do
itself — anything needing the partner credentials or the session cookies — goes
through this app's own **`app/api/*`** routes, which run on the server and relay
to the **Keen HTTP API**. Separately from the chat, entanglement runs an
org→site **events** channel (a long poll) so the Keen organization can push a
forced logout or a "space changed" notice into an open browser.

---

## Read next

| File | What it covers |
|------|----------------|
| [`architecture.md`](architecture.md) | The layers: route groups, the layer stack, server‑seeded identity, and the `app/api/*` proxy routes. Also the separate org→site events channel: the boot order of the certificate, the webhook's secret path, and what a WAKE does to open browsers. |
| [`pages.md`](pages.md) | Every page — guest (login/register/confirm/reset) and app (chat shell + `/user` account) — what it does, its guard, and the flow it drives. |
| [`chat-sdk.md`](chat-sdk.md) | The five SDK layers and how to USE them — including the exact ChatShell instantiation pattern and `runFlow({chatId, prompt})`. |
| [`callbacks.md`](callbacks.md) | `onStream` vs `onSystem` vs `onStatus` vs `onRunning` vs `onWelcome` — signatures, what fires each, and what the app does with it. |
| [`errors.md`](errors.md) | The error taxonomy: `E….` status codes and their prefix/retry contract, the SDK‑level failures (`FatalSendError`, cancel, timeouts), WebSocket close codes (1006 / 1009), and the site's own HTTP refusals (401 / 403 / 429 / 503). |
| [`cookies.md`](cookies.md) | How request cookies reach a flow's **script nodes** — the two `cookies` shapes (names vs explicit map) and the path to `system/cookies`. |
