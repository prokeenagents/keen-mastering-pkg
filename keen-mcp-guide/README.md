# Keen MCP server — how a building agent operates the platform

The Keen **MCP server** is the door an AI agent uses to *configure* Keen without a human clicking through the admin console: spaces, agents and their settings, the API-access chain a partner/runner needs, caches + wake, and the agent's own end-user identities (MCP consumers). It exposes the org admin surface as **MCP tools** — 96 of them — over **Streamable HTTP**.

> **For the AI reading this:** you PROVISION here, you do not chat here. Section 5 is the canonical 15-step recipe for setting an organization up for a bot — follow it in order and remember every value it marks. Build the space, the agent, the API chain and a consumer with these tools, then hand the result to the **agent-runner** (`../agent-runner/`) which runs and verifies the flow. Stay at the product level: never inspect servers, containers or infrastructure — everything you need is a tool call.

---

## 1. Connect — but ASK first

**Your first question to the human, before anything else: "Which Keen are we working on — what is the sandbox URL?"** Everything below derives from that one answer. If the answer is **`localhost`** (in any form — `https://localhost`, `localhost`, `127.0.0.1`), you are in the **LOCAL** environment and you switch to the local column automatically — do not ask again. Any **real URL** means a **real sandbox**: use the SANDBOX column as-is (real certificate, `wss://`, `npm run dev`) and treat it as a live environment — confirm before destructive tools.

| | **LOCAL** (answer was `localhost`) | **SANDBOX** (answer was a real host, e.g. `keen.example.com`) |
|---|---|---|
| Keen host | `https://localhost` | `https://<host>` |
| MCP endpoint | `https://localhost/mcp` (a local *development* stack also publishes it directly on `http://localhost:5545/mcp`) | `https://<host>/mcp` |
| Chat WebSocket — entanglement (`KEEN_WS`, opened by the **browser**) | `wss://localhost/ws-keen` (through the local nginx edge — open `https://localhost` once in that browser and accept the self-signed certificate, or the socket closes 1006 with no reason; only a browser on the stack's own machine reaches it) | `wss://<host>/ws-keen` |
| Chat WebSocket — runner (`run.ts`, not configurable) | derives `wss://localhost/ws-keen` (through nginx; needs the TLS switch below) | derives `wss://<host>/ws-keen` |
| TLS | self-signed — `run.ts` needs `NODE_TLS_REJECT_UNAUTHORIZED=0`; `keen-deploy` needs `KEEN_TLS_INSECURE=true` in the runner `.env` (or `--insecure`) | real certificate, nothing to switch |
| entanglement start command | `npm run dev-local` (Windows: `npm run dev-local:win`) | `npm run dev` |
| `KEEN_HOST` in the runner `.env` | `localhost` | `<host>` (bare, no scheme) |

| | |
|---|---|
| **Endpoint** | `https://<keen-host>/mcp` (the same host as the admin console; a local development stack also exposes it directly on `http://localhost:5545/mcp`) |
| **Transport** | MCP **Streamable HTTP**. The server is *stateful*: your client's `initialize` mints a session (`mcp-session-id` header) and that session holds your auth token. |
| **Health** | `GET /healthz` (alive) · `GET /readyz` (alive **and** connected to the edge bus; the org tier's own availability shows up as a per-call 503) |

Any Streamable-HTTP MCP client works. (The Claude Code commands below are operator guidance for that client, not part of Keen.) With Claude Code, for example: `claude mcp add --transport http keen https://<keen-host>/mcp` (check `claude mcp add --help` for your version). **LOCAL note:** `claude mcp add` has no flag to trust a self-signed certificate (`DEPTH_ZERO_SELF_SIGNED_CERT`), so on `localhost` register the direct plain-HTTP port instead — `claude mcp add --transport http keen http://localhost:5545/mcp` (a development stack only — a production-shaped local stack publishes no direct service ports) — or start Claude Code with `NODE_EXTRA_CA_CERTS=<path to the sandbox's server.crt>` and keep the https URL. A newly added server is picked up when the session (re)starts (`claude --continue`), not mid-session.

## 2. Identity — the MCP account

You act **as an MCP account**: a headless "agent helper" identity a human admin creates once in the console (**Organization → MCP Accounts** — see `../keen-admin-guide/02-organization.md`). It has:

- an **ID** (public, on its page) and a **secret** (shown to the admin **once**, at creation or after *Rotate Secret*),
- a **role** — the same roles humans have; the role's permission scopes decide what you may do,
- an **Enabled** switch — off means you cannot authenticate.

**Log in** with the `mcp_login` tool: `{ id, secret }`. The org token stays inside your MCP session (it is never returned to you); every other tool then acts *as that account* — the platform re-checks its role on each call and the action log records the account, exactly like a human admin. The session refreshes its own token automatically; `logout` drops it.

*(A server dedicated to one agent may carry `MCP_ACCOUNT_ID` / `MCP_ACCOUNT_SECRET` in its environment — then the first gated tool call logs in by itself and `mcp_login` is only needed to switch identity. On a shared server, always `mcp_login`.)*

**Ask for the right role.** The role must carry the scopes for what you will do. A full build (below) needs write on: `spaces`, `agents`, `clients`, `certificates`, `webhooks`, `contracts`, `api_keys`, `cache`, `mcp_consumers` (and read on `consumer` if you look at human consumers). An `admin` role passes everything. Scopes are explained in `../keen-admin-guide/14-limits-and-scopes.md`.

## 3. The rules of the road (what an MCP account can and cannot do)

| Area | You can | You cannot |
|---|---|---|
| Spaces, agents, agent settings | full control (per your scopes) | — |
| API access chain — clients, certificates, webhooks, consumer contracts, api keys | full control (per your scopes), incl. rotate / wake / rebuild caches | — |
| **MCP consumers** (your own end-user identities) | **everything** — create, assign contract + spaces, enable/disable, rotate secret, delete, **mint their token** (with its id + secret). This covers every MCP consumer in the organization, not only the ones you created: `createdBy` is a record, not an owner, so the consumers of a deleted MCP account can be taken over by another | — (only MCP accounts provision them; humans can also disable, rotate or delete — never create or assign) |
| **Human consumers** (partner end users) | list / view | create, reset password, assign spaces/contract, delete |
| **MCP accounts** (other agents) | list / view — to check one exists | create, change role/enabled, rotate, delete — **regardless of your role** |
| Human accounts, roles | nothing | everything — those pages are closed to MCP accounts |
| Cache, logs | per your scopes | — |

Every `delete_*`, `rotate_*` and `reset_space_deployment_token` is **destructive** (marked `destructiveHint`) — confirm with the human before calling. A tool that fails returns `isError` with the platform's status + message — read it and act, don't retry blindly:

- **401** → no usable session token (the server already tried one refresh); `mcp_login` again.
- **403** → a scope you lack, or a rule above (`MCP accounts may not access this resource`; `Only MCP accounts may manage MCP consumers` — raised on create / assign / token when the caller is a human, not on enable / rotate / delete, which a human with `mcp_consumers` write may also do).
- **406** → a refused request: validation, a duplicate name, `rebuild_api_key_cache` on a half-wired key (the message names the four bindings), or — on the consumer-token tools — a uniform refusal that never says *which* check failed.
- **400** → `wake_api_key` on a half-wired key — the message names what is missing (`no webhook / client / certificate / consumer contract bound`). **404** → an unknown id.
- **503** → the org tier is not answering right now; wait and retry.

## 4. The tools, by domain

| Domain | Scope | Tools |
|---|---|---|
| Session | — | `mcp_login`, `logout` |
| Spaces | spaces | `list_spaces`, `get_space` (carries the **deployment token**), `create_space`, `update_space`, `delete_space`, `reset_space_deployment_token`, `clear_spaces_cache` |
| Agents | agents | `list_agents` (by space), `get_agent`, `create_agent`, `update_agent`, `delete_agent`, `get_agent_settings` / `update_agent_settings` (runtime JSON settings), `get_agent_front_settings` / `update_agent_front_settings` (partner-facing) |
| Clients | clients | `list_clients`, `get_client`, `create_client` (secret shown once), `update_client`, `rotate_client`, `delete_client` |
| Certificates | certificates | `list_certificates`, `get_certificate`, `create_certificate`, `update_certificate`, `rotate_certificate`, `delete_certificate` |
| Webhooks | webhooks | `list_webhooks`, `get_webhook`, `create_webhook` (the partner/runner **origin** + webhook URL), `update_webhook`, `delete_webhook` |
| Consumer contracts | contracts | `list_consumer_contracts`, `get_consumer_contract`, `list_contract_spaces`, `create_consumer_contract`, `update_consumer_contract`, `delete_consumer_contract`, `update_consumer_contract_policy`, `assign_contract_spaces`, `assign_contract_default_system_spaces`, `assign_contract_default_outside_spaces` |
| API keys | api_keys | `list_api_keys`, `get_api_key`, `create_api_key` (secret shown once), `update_api_key` (bind client / certificate / contract / webhook), `rotate_api_key`, `wake_api_key`, `delete_api_key` |
| Cache | cache | `get_cache_status`, `create_cache` (whole resource), `invalidate_cache`, **`rebuild_api_key_cache`** (only what is bound to one key) |
| Human consumers | consumer (read) | `list_consumers`, `get_consumer`, `get_consumer_info` |
| MCP consumers | mcp_consumers | `list_mcp_consumers`, `get_mcp_consumer`, `create_mcp_consumer`, `assign_mcp_consumer_contract`, `assign_mcp_consumer_spaces`, `set_mcp_consumer_enabled`, `rotate_mcp_consumer_secret`, `delete_mcp_consumer`, **`get_mcp_consumer_token`**, `refresh_mcp_consumer_token` |
| MCP accounts | mcp_accounts (read) | `list_mcp_accounts`, `get_mcp_account` |
| Accounts / roles / own account | account, roles | `list_accounts`, `get_account`, `get_account_info`, `list_roles`, `get_role`, `get_own_account`, `update_own_profile`, `reset_own_password` … — **closed to MCP accounts** (403 `MCP accounts may not access this resource`); listed only so you recognise them. Your own identity is the MCP account you logged in with — there is nothing to read there. |
| Logs | logs | `list_log_settings`, `update_log_setting`, `get_log_audit`, `get_log_file`, `list_log_records`, `reveal_log_token`, `create_log_record`, `update_log_record`, `delete_log_record` |

Every tool prints its own description and input schema — read them; they name the exact scope and any once-only secret.

## 5. The golden path — how an organization is set up for a bot (the canonical 15 steps)

Follow this order exactly. After every reply, **remember the values marked ⟶** — you will need them later, and the once-only secrets never come back. Never paste real secrets into chat, logs or committed files; the placeholders below are the only thing that belongs in a document.

**0. Ask two things up front** — (a) "What is the sandbox URL?" `localhost` ⇒ LOCAL, otherwise SANDBOX (section 1's table): every URL, the TLS switch and the start commands follow from it. (b) "Where is the entanglement project on disk?" (the partner reference site you will run and tunnel in step 6).

**1. Create the Space** — `create_space { title, description }`
 ⟶ the space **ID** · ⟶ the space's **Deployment Token** (also visible via `get_space`; `reset_space_deployment_token` re-mints it — the old one is refused for every new deploy connection at once, while a deploy session already open with it can finish within its short window).

**2. Create the Agent** — `create_agent { spaceId, displayName, agentId, startFlow, startNode }`
 2.1 Fill and ⟶ remember **Start Flow**, **Start Node**, the **agent name** and the **agent id** (the slug: lowercase letters + single dashes, no digits, **unique across the organization**). Make it **4–60 characters**: the platform accepts 3–100, but the flow builder's Agent ID field accepts only 4–60, so a slug in that range passes every check. This is important — the runner and the platform address the agent by the slug, and `startFlow`/`startNode` (PascalCase, 3–60) must match the flow you deploy in step 14.
 2.2 The agent is created **under the space** from step 1 (`spaceId`) — that is the assignment.
 2.3 Optional — its two settings blobs: `update_agent_settings { id, jsonSettings }` (the runtime JSON Settings a flow's scripts read through `system/settings`) and `update_agent_front_settings { id, jsonSettings }` (the partner-facing Front Settings). `id` is the agent's record id from 2.1 (not the slug); `jsonSettings` is the WHOLE blob **serialized as a JSON string** (≤ 1,000,000 characters). Both are write-through: scripts see the new values on their next run — no redeploy. Read back with `get_agent_settings` / `get_agent_front_settings`.

**3. Create the Client Certificate** — `create_certificate { name, secretKey }` ⟶ its **ID**. `secretKey` (16–32 characters) is optional, but pass one: it seals the private claims of every consumer token (consumer id, email, spaces, tenant key). Without it the certificate shows `Unset` and the seal falls back to a fixed, publicly known key — tokens still work, but anyone holding one can read those claims.

**4. Create the Client** — `create_client { name }` ⟶ its **ID** and its **Secret** (shown once).

**5. Create the Contract** — `create_consumer_contract { name }` ⟶ its **ID**.
 5.1 Assign the space from step 1 to it — `assign_contract_spaces { id, spaceIds: [spaceId] }` — and set the **outside-consumer settings**: `update_consumer_contract_policy { id, outsideRegistration, otpInsideRegistration, otpOutsideRegistration, blockOutsideRegistrationLogins, blockSystemRegistrationLogins }` (all five booleans every call — a partial call is rejected) and `assign_contract_default_outside_spaces { id, spaceIds: [spaceId] }` (the spaces an outside consumer gets by default).

**6. Start the entanglement project, find its port, tunnel it** — in the project path from step 0:
 6.1 The site **refuses to boot** unless all six `KEEN_*` values are non-empty (`KEEN_HOST`, `KEEN_ORIGIN`, `KEEN_CLIENT_ID`, `KEEN_CLIENT_SECRET`, `KEEN_API_KEY_ID`, `KEEN_API_KEY_SECRET` — it throws `Keen config missing from the environment` at startup). So before starting it: make sure `.env.local` exists (copy `.env.example` if not), put in the host block for the environment (section 1), the client id + secret from step 4, and **create the api key now** — `create_api_key { name }` ⟶ its **ID** + **Secret** (shown once) — and put those in too (its bindings come in step 8.1). For `KEEN_ORIGIN` use a placeholder for this first boot (e.g. `https://pending.local`); step 9 replaces it with the real ngrok URL and restarts.
 6.2 Start it with the command for the environment: LOCAL → `npm run dev-local` (Windows: `npm run dev-local:win`); SANDBOX → `npm run dev` (Windows: `npm run dev:win`).
 6.3 **Read the port from its output** (`Local: http://localhost:<port>` — Next takes 3000, or the next free port if 3000 is busy). Do not assume 3000.
 6.4 Tunnel **that** port — `ngrok http <port>` — and take the public URL it prints (`https://<xxxx>.ngrok-free.app`). ⟶ remember it as `<ngrok>`. (If you cannot run processes yourself, give the human these exact commands and ask for the port and the URL.)

**7. Create the Webhook** — `create_webhook { name, origin, webhook }` with
 - `name`    = a label (unique, up to 100 characters)
 - `origin`  = `<ngrok>` (the exact `scheme://host` — this is what the partner site / runner will present; anything else is silently dropped)
 - `webhook` = `<ngrok>/api/keen-webhook`
 ⟶ the **webhook ID**.
 Where the allow-list lives: there is no origin on the api key itself. The platform lets in exactly the `origin`s of the webhook records bound to **fully-bound** api keys (all four bindings), read from the served `api_keys` cache — so this origin is accepted only once step 8.1 binds the record, and a later `update_webhook` reaches the allow-list only through `rebuild_api_key_cache`.

**8. The Api Key** — already created in 6.1 (`create_api_key { name }` ⟶ **ID** + **Secret**, shown once). If you skipped that, create it now.
 8.1 Bind **all** the resources created so far to it — `update_api_key { id, clientId, certificateId, consumerContractId, webhookId }`. A key with any binding missing is not live. (`create_api_key` also accepts the four ids directly, so a key created after steps 3–7 can be bound in the same call.)

**9. Finish `.env.local` and RESTART the entanglement project** — add the ngrok URL from step 6 as `KEEN_ORIGIN` and the client / api-key values from steps 4 and 8. Keep ONLY the host block that matches the environment from step 0, delete the other:

```bash
# LOCAL DEVELOPMENT
KEEN_HOST=https://localhost
KEEN_WS=wss://localhost/ws-keen          # the browser opens it from the https ngrok page: wss only (ws:// is mixed content); accept https://localhost's self-signed cert in that browser first

# SANDBOX
KEEN_HOST=https://<sandbox-host>            # e.g. https://keen.example.com
KEEN_WS=wss://<sandbox-host>/ws-keen

# =============================================================================
KEEN_ORIGIN=<ngrok>                          # the origin from step 7, exact
# =============================================================================
KEEN_CLIENT_ID=<client id, step 4>
KEEN_CLIENT_SECRET=<client secret, step 4>
KEEN_API_KEY_ID=<api key id, step 8>
KEEN_API_KEY_SECRET=<api key secret, step 8>
```

 Then **restart** it (stop the process from step 6.2 and start it again with the same command) — the Keen connector reads its configuration when it is constructed, so a running site never picks up new `.env.local` values without a restart. Keep the ngrok tunnel running; the site behind it is unchanged.

**10. Rebuild the api key's cache resources** — `rebuild_api_key_cache { id }` (rebuilds ONLY what is bound to this key: the key, its certificate, client, contract + policy, the contract's spaces and their agents).
 10.1 **Wake** the api key — `wake_api_key { id }` — **only once every resource above exists and is bound** (client, certificate, contract, webhook; a half-wired key answers 400 naming what is missing). The partner site (the restarted entanglement from step 9) is handed the certificate and told to re-read the fresh caches. One rebuild + one wake is the whole refresh; **repeat this pair after every later change** to anything bound to the key.

**11. Create the MCP Consumer** — `create_mcp_consumer { name, consumerContractId, space: [spaceId], enabled: true }`
 ⟶ the reply shows `{ consumer, secret }` (the worker wraps it as `result`, the MCP server unwraps it): keep `consumer.id` and `secret` (shown **once**). `name` is unique and immutable; `space` must be within the contract's spaces.

**12. Take its token** — `get_mcp_consumer_token { id, secret }` ⟶ `access_token`, `refresh_token`, `expires_in`. This is the consumer's working credential; it is issued only here.

**13. Use the agent-runner with that token** — the runner carries exactly **two credentials**: the consumer `access_token` (the only auth on the chat WebSocket — sent as `userContext.accessToken` on every frame) and the space's **Deployment Token** (only for `keen-deploy`). It never uses the client secret or the api-key secret — those belong to the entanglement site (step 9) alone. Fill `../agent-runner/.env`:

| `.env` key | value |
|---|---|
| `KEEN_HOST` | from step 0: `localhost` (LOCAL — and export `NODE_TLS_REJECT_UNAUTHORIZED=0` for `run.ts`) or the bare sandbox host |
| `KEEN_TLS_INSECURE` | LOCAL only: `true` — `keen-deploy` is a Go binary and needs its own self-signed switch (`NODE_TLS_REJECT_UNAUTHORIZED` does not reach it) |
| `KEEN_TOKEN` | the `access_token` from step 12 |
| `KEEN_USER_ID` | the MCP consumer's `id` from step 11 |
| `KEEN_EMAIL` | any non-empty value (an MCP consumer has no email; presence-checked only) |
| `KEEN_ORIGIN` | the `origin` from step 7 — exact match |
| `KEEN_SPACE_ID` / `KEEN_AGENT` | the space ID (step 1) / the agent **slug** (step 2) |
| `KEEN_DEPLOY_TOKEN` | the space's Deployment Token (step 1) |
| `KEEN_PROJECT_DIR` | the flow project root (step 14) |

**14. Create the project and upload it** — write the flow project (`src/flows/*.flow` + `src/scripts/`, with the `startFlow`/`startNode` from step 2), then `keen-validate && keen-deploy` (the Go deployment). The platform scans, promotes and answers `deployed` / `rejected`.

**15. Run a test prompt** — `npx tsx run.ts --prompt "…" --json` and read the trace (live stream + the flow-tree). Fix → validate → deploy → prompt, until it does what you want.

**When the ngrok URL changes** (a free tunnel gets a new URL each time it restarts): the URL lives in FOUR places and all four must move together —
 1. the **webhook record**, both fields: `update_webhook { id, origin, webhook }`;
 2. the site's `.env.local` `KEEN_ORIGIN` — then **restart** the site (the restart also mints it a fresh application token);
 3. the runner's `.env` `KEEN_ORIGIN`;
 4. every **consumer token** minted under the old origin — the origin is a claim inside it: re-mint the MCP consumer's (`get_mcp_consumer_token` with the stored id + secret) and update `KEEN_TOKEN`; human consumers of the site simply sign in again.

 Then `rebuild_api_key_cache` → `wake_api_key` — the rebuild is what puts the new origin on the allow-list (`update_webhook` alone never reaches it). Skipping any one = silent drops or `Invalid token`.

**When the consumer token expires** (`expires_in`): the runner cannot refresh it itself — by design an MCP consumer's token moves only through this server. Call `refresh_mcp_consumer_token { refresh_token }` (or `get_mcp_consumer_token` again with the stored id + secret) and update `KEEN_TOKEN`. A disabled, deleted or contract-less consumer is refused (406) — fix the consumer, not the token.

## 6. Secrets discipline

Shown **once**, never retrievable again: the MCP account secret (the admin's), the client secret, the api-key secret, the MCP consumer secret, the space deployment token (re-mintable). Store them in the runner's `.env` or a secret store the moment you receive them; never echo them into chat, logs or files that get committed. Lost one → `rotate_*` / `reset_space_deployment_token` mints a new one and the old one stops working at once for anything **new**: no new sign-in, token or deploy connection accepts it. What was already issued keeps running — application tokens survive `rotate_api_key`, an MCP consumer's current token pair keeps refreshing after `rotate_mcp_consumer_secret`, and a deploy session already open finishes its short window. A **leaked** secret therefore needs more than a rotate: `delete_api_key` (or unbind its certificate / contract) for a partner key, `set_mcp_consumer_enabled false` or `delete_mcp_consumer` for a consumer — and even those leave an access token already issued valid until it expires (a consumer's lives up to 7 days on today's sandboxes).

## 7. Watch out for

- **Ask for the sandbox URL first; `localhost` means LOCAL.** Never assume the environment — the wrong host/WS/TLS combination fails silently.
- **`agentId` is a slug, `space` is an id.** Mixing them gives "agent not found" at run time. Keep the slug 4–60 characters (letters + single dashes) so the platform and the flow builder both accept it; it is unique across the organization.
- **Half-wired api key = dead key.** All four bindings (client, certificate, contract, webhook) or nothing works — `rebuild_api_key_cache` (406) and `wake_api_key` (400) name the missing binding; the consumer-token tools only refuse (uniform 406), they never say why.
- **Change → rebuild → wake.** Forgetting the pair is why "I changed it but the site/runner still sees the old thing."
- **Tunnel the port Next actually reports.** If 3000 was busy the site is on 3001 — `ngrok http 3000` then tunnels the wrong thing (or nothing); read the `Local:` line. (On a machine that also runs a local Keen stack's admin console on 3000 this is the normal case, not the exception.)
- **`KEEN_WS` is opened by the browser, from the https tunnel page** — so it is always `wss://…/ws-keen` on the Keen host (LOCAL: `wss://localhost/ws-keen`, after accepting the self-signed certificate in that browser), never `ws://`, never the ngrok URL.
- **A running entanglement does not see `.env.local` changes** — restart it after step 9.
- **Origin is exact-match.** `https://host` ≠ `https://host:3000`. A wrong origin is a *silent* connection drop, not an error.
- **Names are unique and (for MCP consumers) immutable** — a duplicate name is a 406; pick the final name at creation.
- **You cannot manage other MCP accounts or human consumers** — ask the human admin.
- **`delete_*` is permanent** — confirm first.
