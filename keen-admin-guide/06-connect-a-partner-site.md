# Connect a partner site — end to end

**In one line:** once the admin has wired API access, the partner's **server** gets an application
token, completes a certificate handshake, fetches its resources, signs in its consumers, and opens the
live chat by an agent's **slug** — staying current afterward through notify-then-fetch.

## What you're wiring

A **partner site** is an external website that talks to your agents. This guide is the team-facing
walkthrough of that wiring — the same ground the public "Connecting a Site" page covers, written as a
recipe. The shape to hold in your head:

- the **admin** builds the API access chain first (four bindings on one key → `05-api-access.md`),
- the partner's **server** holds the long-lived credentials and does the exchanges,
- the partner's **browser** only ever holds a per-user token (an end user's own access token),
- and a **secure live connection** carries the actual chat.

This is a **two-token, OAuth-style** model: the server's **application token** stays server-side; each
signed-in end user's **access token** lives in the browser. The two are always presented together on
consumer calls (see `09-consumers.md` for the consumer side in depth).

## Before you start — the admin's part

Nothing connects until API access is **fully bound**. In the admin console (sidebar group **Api**),
create and bind the four siblings on one **Api Key** — in this order: a **Certificate**, a
**Client**, a **Consumer Contract** (with the space ticked **Assigned** in its Spaces card and the
**Registration & Login Policy** set), and a **Webhook** (the partner's **Origin** + **Webhook URL**)
— then the key, binding all four. Full steps: `05-api-access.md` (they are steps 3–8 of the README's
Golden path). Then hand the partner exactly three things:

1. the **Client id + secret** (the secret is **reveal-once** — copy it at creation),
2. the **Api Key id + secret** (the key is reveal-once too), and
3. confirmation of the registered **Origin** and **notification URL**.

**If the partner site is the reference site** (the entanglement project), those values go into its
`.env.local` — the README's Golden path steps **6** and **9** give the exact order:

| Key | Value |
|---|---|
| `KEEN_HOST` | LOCAL `https://localhost` · SANDBOX `https://<host>` (e.g. `https://keen.example.com`) |
| `KEEN_WS` | LOCAL `wss://localhost/ws-keen` · SANDBOX `wss://<host>/ws-keen` — the chat connection the **browser** opens. Point it at the Keen host, never at the ngrok tunnel. On LOCAL, open `https://localhost` once in the same browser and accept its self-signed certificate, or the chat socket closes silently. Plain `ws://` doesn't work from the https tunnel page (browsers block it as mixed content). |
| `KEEN_ORIGIN` | `<ngrok URL>` — exactly the Origin on the Webhook (a placeholder such as `https://pending.local` for the very first boot) |
| `KEEN_CLIENT_ID` / `KEEN_CLIENT_SECRET` | the Client's id + secret |
| `KEEN_API_KEY_ID` / `KEEN_API_KEY_SECRET` | the Api Key's id + secret |
| `KEEN_WEBHOOK_SECRET` | a secret you generate (`openssl rand -hex 32`, at least 32 characters). It is the last segment of the Webhook URL — Keen does not sign its webhooks, so the site accepts a delivery only on `/api/keen-webhook/<this value>` and answers 401 to anything else. Rotate it here AND on the Webhook if it ever leaks. |

The site **refuses to boot** unless the seven values other than `KEEN_WS` are all filled (always set
`KEEN_WS` too — without it the chat never connects), and it reads them **only when it starts** —
after any `.env.local` change, stop it and start it again.
Placeholders only in notes — never write a real secret anywhere else. Start it with
`npm run dev-local` (`npm run dev-local:win` on Windows) when the Keen host uses a self-signed
certificate, or `npm run dev` (`npm run dev:win`) when it has a trusted one — both are development
servers; a production build is `npm run build` followed by `npm run start`. **The tunnel goes to the
port the site reports** in its `Local: http://localhost:<port>` line — `ngrok http <port>`; 3000 only
if 3000 was free (on a machine that also runs a local Keen stack's admin console on 3000, it's 3001).
Its notification URL is `<ngrok URL>/api/keen-webhook/<KEEN_WEBHOOK_SECRET>`.

Finally, on the key's page: **Rebuild Resource Cache** (the api-key cascade, `07-caches.md`), then
**Wake** to push the first configuration (`08-wake.md`) — Rebuild first, Wake second.

## The wiring, step by step (server first, then browser)

1. **Keep the credentials server-side.** The Client secret and API key live on the partner's server,
   never in the browser. The browser only ever holds an access token minted for one end user.
2. **Get an application token.** The server exchanges its client credentials for an **application
   token** — the standing credential it presents on each end user's behalf. It stays on the server.
   It has **no expiry and no refresh**: it keeps working until the admin **deletes** the key,
   unbinds any of its four bindings, or binds it to a different client (a different certificate or
   contract, or a new contract key, also refuses it for partner sign-ups) — then the server simply
   requests a new one (the reference site requests it at start-up and retries until it succeeds).
3. **Complete the certificate handshake.** The server asks for a one-time **code**, then **claims** it.
   On a valid claim, KeenAgents delivers the **certificate material** (the public key the site uses to
   verify KeenAgents-issued tokens, plus the shared secret) to the registered **notification URL**.
   This material **cannot be pulled with a request** — it only ever arrives at the notification URL,
   so store it when it lands. (If it's lost, run the handshake again, or ask the admin to press
   **Wake** — both deliver it afresh.)
4. **Fetch the resources.** With the application token the server reads its **consumer contract**,
   its **consumer policy** and each **agent's front settings** — these three are scoped to that one
   key, so for them a partner only ever sees its own tenant's data. The **space list** is different: it
   returns the organization's **whole** space collection (every space, with its agents), not just the
   partner's — the partner must keep only the spaces listed in its **consumer contract** (that
   `spaces` set is the boundary of what it may use).
5. **Sign in the end users.** The site registers and authenticates its **consumers**. Where the
   contract's policy requires it, a **one-time passcode** step is part of login. Each consumer session
   is its own two-token pair; self-service covers profile edits, password reset and account deletion.
   Details: `09-consumers.md`.
6. **Open the live chat.** The browser connects over a **secure, live connection** and runs an agent by
   naming its **slug** (its stable id — not the display name, not any other identifier). Each run is
   verified against the signed-in consumer's access token.
7. **Stay in sync.** The site keeps its **notification URL** registered. Whenever the configuration
   changes — or an admin presses **Wake** — KeenAgents POSTs a small notice there, and the site
   **re-fetches** the affected resources over its authenticated connection. The notice carries **no
   data** — it's only a nudge to re-read. The one exception is the certificate delivery from step 3
   (also re-sent by **Wake**): that POST does carry the certificate material itself.

## The requests, in shape

Interface-level only. The partner's KeenAgents host is provided at onboarding (the reference site
calls it `KEEN_HOST`); every path below is relative to `<KEEN_HOST>/keen-api` — that public prefix is
what the platform's edge exposes (internally it maps to the service's `/v1/` routes, which you may
see in engineering material). Every call carries the partner's browser **Origin** header, matched
exactly.

```
1 · Application token (server-side, once; no expiry, no refresh — re-request if it stops working)
POST /keen-api/auth/application_token?client_id=<kcid_…>
     Origin: https://your-site.example
     Authorization: <base64 of "client_secret|api_key_id|api_key_secret">   // bare base64 — no "Bearer", no "Basic"
     (no request body)
   → { "success": true, "status": 200, "message": "Success",
       "result": { "type": "Bearer", "access_token": "<application_token>" } }   // keep on the server
   Any failure — wrong secret, unknown id, half-wired key — is a uniform HTTP 500 with no reason.

2 · Certificate handshake (issue a code, then claim it)
GET  /keen-api/resources/certificate?client_id=<kcid_…>    Authorization: Bearer <application_token>
   → { "result": { "code": "…" } }              // code lives 2 minutes, single use
POST /keen-api/resources/certificate?client_id=<kcid_…>    Authorization: Bearer <application_token>
     { "code": "…" }
   → { "success": true }     // material is POSTed to the notification URL

3 · Fetch resources (all Bearer + Origin)
GET /keen-api/space/list                                     // the org's WHOLE space collection, with agents — filter by the contract's spaces
GET /keen-api/resources/consumer-contract                    // tenant identity + allowed spaces (scoped to the key)
GET /keen-api/resources/consumer-policy                      // live registration / login policy (scoped to the key)
GET /keen-api/resources/agent-front-settings?agentId=<slug>  // one agent's partner-facing config (scoped to the key)
```

(`api_key_id` is the key's **Api Key ID** from its detail page; `api_key_secret` is the `kak_…`
plaintext shown once at creation; `client_secret` is the `ksec_…` plaintext shown once. Placeholders
only — never paste real values into notes.)

## What the partner fetches (and it stays fresh)

| Resource | What it is |
|---|---|
| **Spaces & agents** | The organization's full space collection (every space, with the agents inside it — each agent's slug, display name, run entry and active state). Not filtered per partner: the partner keeps the spaces its **consumer contract** lists. The **slug** is what names a chat. |
| **Consumer contract** | The tenant identity and the master set of spaces it grants — the boundary of what its consumers can reach. |
| **Consumer policy** | The live registration/login rules (outside registration, one-time passcode, blocked logins) + the default spaces new consumers get. |
| **Agent front settings** | The partner-facing config an admin defines per agent, fetched per agent by slug. |
| **Certificate material** | Arrives only at the notification URL (via the handshake, or a **Wake**); it can't be pulled with a request — store it on arrival. |

All of these are kept current for the partner automatically — a change on the admin side is visible on
the next fetch (see `07-caches.md`). The **notify-then-fetch** loop is how the site learns *when* to
re-read.

## Watch out for

- **Origin must match exactly.** Every request carries an `Origin` header, matched on
  `scheme://host[:port]` against the one registered on the key's Webhook (only default 80/443 are
  omitted; no wildcards). A mismatch is **silently dropped** — the caller sees a connection reset or a
  generic gateway error, never a descriptive one. "Can't connect at all" → check the Origin first.
- **Reveal-once secrets.** The Client secret and the Api Key each appear **once** — lost = the admin
  rotates and re-hands; there is no recovery. The certificate material is different: it can't be
  *pulled*, but a fresh handshake (or the admin pressing **Wake**) delivers it again.
- **Notify-then-fetch — the notice carries no data.** It's a hint to re-read, delivered once without
  retries (a 5-second attempt, then it's gone). The site must fetch the real values itself; never act
  on the notice alone. The only POST that carries a payload is the certificate delivery. Same model
  as the admin's **Wake** (`08-wake.md`).
- **A half-wired key = silence, not an error.** If any of the four bindings is missing, the key's
  Origin isn't allow-listed, so the partner's calls are **silently dropped** (connection reset /
  gateway 502) — and where a call does get through, the token request answers a uniform **HTTP 500
  "Invalid request"** with no reason. Nothing tells the partner *which* binding is missing; only the
  admin can see that, on the key's detail page. It's an operator wiring task on the key, not a partner
  outage → `05-api-access.md`.
- **Run agents by slug.** Naming the display name or any other identifier fails — the slug is the
  stable handle (`03-spaces-and-agents.md`).
- **Credentials stay on the server.** Only the per-user access token belongs in the browser — never
  the client secret or the API key.
- **The tunnel URL lives in four places.** A new ngrok URL (a free tunnel gets one each time it
  restarts) means moving all four together:
  1. the **Webhook** record — both its **Origin** and its **Webhook URL**
     (`<ngrok URL>/api/keen-webhook/<KEEN_WEBHOOK_SECRET>` — same secret, new host), Api → Webhooks → the webhook → **Save**;
  2. the site's `KEEN_ORIGIN` — then **restart** the site (the restart also gets it a fresh
     application token);
  3. the agent-runner's `KEEN_ORIGIN`, if you use the runner (`../keen-mcp-guide/README.md`);
  4. every **consumer token** issued under the old URL — the origin is written into each token:
     people simply sign in again; an MCP consumer's token is re-minted through the Keen MCP server.

  Then on the key: **Rebuild Resource Cache** (a Webhook edit reaches the allow-list only through a
  Rebuild) and **Wake**. Miss one and the calls are silently dropped or the tokens are refused.
