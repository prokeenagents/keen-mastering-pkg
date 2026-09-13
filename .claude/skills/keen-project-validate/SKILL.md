---
name: keen-project-validate
description: Pick a saved project (working_dir/<spaceId>/) and verify that everything it needs is present and correct — the saved files, the platform records (space, agent, API chain bindings, MCP consumer), the running site + tunnel, and the credentials — with a pass/fail table and the exact fix for every failure. Read-only unless the person asks to fix.
disable-model-invocation: true
allowed-tools: Bash Read AskUserQuestion
---

Work from the package root. This command CHECKS; it changes nothing unless the person picks a fix at the end. Never print a secret; report only whether one is present/valid.

## 1. Pick the project
Read every `working_dir/*/project.json`; show a table (space title · spaceId · agent slug · sandbox host · created); ask which one to validate (one option per project + nothing else). If `working_dir/` has no projects, say so and stop ("run /keen-start → Create new project").

## 2. Connect
Point `.mcp.json` at `project.sandbox.mcpUrl` if it differs (tell the person to run `/mcp` if the keen tools are not live). `mcp_login` with `mcpAccount.id` + `MCP_ACCOUNT_SECRET` from the project's `.env`. If login fails → row A2 fails; still run the file checks (section 3), skip the platform checks, and report.

## 3. The checks — run ALL of them, then print ONE table: `#` · check · ✅/❌/⚠ · detail · fix
**A. Files**
- A1 `project.json` present, parses, has every key of the schema (sandbox, space, agent, mcpAccount, chain, consumer, paths).
- A2 `.env` present, mode 600, and every required key non-empty: KEEN_HOST, KEEN_TOKEN, KEEN_USER_ID, KEEN_EMAIL, KEEN_ORIGIN, KEEN_SPACE_ID, KEEN_AGENT, KEEN_DEPLOY_TOKEN, KEEN_PROJECT_DIR, MCP_ACCOUNT_ID, MCP_ACCOUNT_SECRET, KEEN_CONSUMER_SECRET, KEEN_REFRESH_TOKEN (+ KEEN_TLS_INSECURE=true when mode is LOCAL). Cross-check: KEEN_SPACE_ID = space.id, KEEN_AGENT = agent.agentId, KEEN_USER_ID = consumer.id, KEEN_ORIGIN = chain.origin, KEEN_PROJECT_DIR absolute + exists.
- A3 `paths.flowProject` exists and holds `package.json`, `src/keen-tools.json`, `src/flows/*.flow` (≥1), `src/scripts/`; `keen-validate --project=<flowProject>` → 0 errors (show its warnings).
- A4 `paths.entanglement` exists with `package.json` and `.env.local`; `.env.local` carries KEEN_ORIGIN = chain.origin, KEEN_CLIENT_ID = chain.clientId, KEEN_API_KEY_ID = chain.apiKeyId, and the host block for the mode.
**B. Platform (via the keen tools)**
- B1 `get_space { id: space.id }` exists; title matches. B2 `list_agents { spaceId }` contains agent.id with agentId/startFlow/startNode as saved, `active: true`.
- B3 `get_api_key { id: chain.apiKeyId }` exists AND is fully bound: clientId = chain.clientId, certificateId = chain.certificateId, consumerContractId = chain.contractId, webhookId = chain.webhookId (each ❌ separately if it differs or is null). B4 `get_certificate`, `get_client`, `get_consumer_contract` each exist; the contract's spaces include space.id. B5 `get_webhook { id: chain.webhookId }`: origin = chain.origin and webhook = `<origin>/api/keen-webhook`.
- B6 `get_mcp_consumer { id: consumer.id }` exists, `enabled: true`, `consumerContractId = chain.contractId`, `space` includes space.id.
- B7 Credentials: `get_mcp_consumer_token { id, secret: KEEN_CONSUMER_SECRET }` → 200 (never print the token); compare with KEEN_TOKEN — if the saved one differs, ⚠ "saved KEEN_TOKEN is older; refresh it" (a 406 = wrong secret / disabled / unbound — say which the earlier rows point to).
**C. Live**
- C1 The site: `curl -s -o /dev/null -w '%{http_code}' http://localhost:<chain.port>` → 2xx/3xx; else ❌ "entanglement is not running on port <port> — start it: `cd <entanglement> && <mode command>`".
- C2 The tunnel: `curl -s http://127.0.0.1:4040/api/tunnels` lists a public URL equal to chain.origin; if ngrok is up on a DIFFERENT URL → ❌ "origin changed — it must move in four places: webhook record, .env.local, this project's .env, and the consumer token must be re-minted, then rebuild + wake" (the golden path's ngrok-change rule); if ngrok is down → ❌ with `ngrok http <port>`.
- C3 Reachability: `curl -s -o /dev/null -w '%{http_code}' <chain.origin>/api/keen-webhook` → not 000 (the partner can be woken).
- C4 Cache: `get_cache_status { resource: "api_keys" }` present; ⚠ if a rebuild has never run since the key was created.

## 4. Verdict + fixes
End with: `VALID — <N>/<N> checks passed` or `INVALID — <k> failing`, then, ONLY if something failed, one question: **"Fix what can be fixed automatically"** / **"Just show me"**. Auto-fixable (do them in order, re-run the failed rows after): rebind a half-wired key (`update_api_key`), re-assign the consumer's contract/spaces, re-enable the consumer, rebuild + wake, re-mint the token and update `.env` (keep `.env.bak`), rewrite `.env.local` from `project.json` (restart required — say so). NOT auto-fixed (report the command instead): starting the site or ngrok, a changed ngrok URL, a deleted space/agent/contract (that is a new project), a wrong consumer secret (ask, or offer `rotate_mcp_consumer_secret`).
