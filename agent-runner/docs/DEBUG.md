# debug — a one-time attach address for the debuggers

The Keen VS Code extension signs in and connects the **flow** and **script** debuggers for you (Start Flow Debugger / Start Script Debugger). `debug.ts` is the **manual** way: it prints the same one-time attach address for any other client — a hand-written `launch.json`, or a CDP tool of your own. Like `deploy.ts` it takes `--key value` or `--key=value` and `-h` / `--help`.

## Before you start

- **The debugger must be switched ON.** It is off by default; the owner or an admin switches it on in the console's **Debugger** page (System group). Off means every connection is refused (switching off also closes open sessions and resumes paused runs).
- **Your role needs the Debugger permission** (scope `debug`, read). The owner and admins have it by role. Only a human console account can debug — never an MCP account.
- **The project is deployed** — you debug the code as it runs on the sandbox.
- **`.vscode/keen.json` carries your console login** — `user` (the e-mail you sign in to the console with) and `password`, next to `server`, `space` and `token`. It is a local secrets file: keep it **git-ignored** and never commit it (`keen-validate` warns when it is not ignored; the deploy never uploads a dot-entry).

```json
{
  "server":   "https://keen.example.com",
  "space":    "<your-space-id>",
  "token":    "<your-deployment-token>",
  "user":     "<your console e-mail>",
  "password": "<your console password>"
}
```

  An optional `"debugHost": "<host name>"` replaces `server`'s host name for the port fallback only (an older server without the debug edge, below); a host name alone — no scheme, port or path.

## What it does

1. **login** — `POST <server>/keen-org-api/v1/auth/login { email: user, password }` → a short-lived access token.
   - **Two-step sign-in:** when your console account has it, the login answers with a code step instead (`statusCode 201` `Verify` and the method — `totp` = your authenticator app, `email` = a mailed code). The tool asks the code — on the terminal (the prompt is on stderr; for an e-mailed code `r` + Enter sends a new one, not before a short wait and only a few times), or from the environment variable `KEEN_MFA_CODE` when there is no terminal (an agent's run: used once, a refused one is not asked again) — and sends `POST <server>/keen-org-api/v1/auth/login/verify { challenge, code }` (a new code: `POST …/auth/login/resend { challenge }`) → the access token.
   - When your organization requires two-step sign-in and your account has none, the login answers `statusCode 202` `Enroll`: the tool stops — set it up in the console first (avatar menu → **Account** → **Security**).
2. **ticket** — `POST <server>/keen-org-api/v1/debug/ticket { kind, space }` with that token (`space` from `keen.json`). The platform re-checks your account, the Debugger permission and the switch, and answers a **debug ticket**: good for **one connection within 5 minutes**, for one debugger (`flow` or `script`) and ONE space only. A breakpoint stops only runs of your `space`, and only the scripts / flow nodes it is set on; every other run runs normally, and `debugger;` statements stop only in such a run.
3. **logout** — `POST <server>/keen-org-api/v1/auth/logout` — **always**, success or not. The tool never keeps an org session.
4. **the mode probe** — `GET <server>/keen-debug/<kind>/dbg/<ticket>/json` (CDP discovery; it does **not** use the ticket up — only the debugger's WebSocket connection does). Since Keen 15.3 both debuggers are served on the server's HTTPS address (443) under `/keen-debug/<kind>/`, and the server publishes no separate debugger ports. The answer decides the mode:
   - a JSON target list → **edge** (Keen 15.3+);
   - a redirect (an older console sends `/login`; never followed), a `404` or an HTML page → **ports**: an older server, reached on `:7101` (flow) / `:7100` (script) with the **same** ticket — on `debugHost` when `keen.json` sets it, else on `server`'s host;
   - anything else (`401` / `403` the debugger's own refusal, `429`, a `5xx`) → a `fail` line, no fallback.
5. Prints the attach address of that mode:

   | | edge (Keen 15.3+) | ports (an older server) |
   |---|---|---|
   | flow | `https://<server>/keen-debug/flow/dbg/<ticket>` | `http://<host>:7101/dbg/<ticket>` |
   | script | `wss://<server>/keen-debug/script/dbg/<ticket>/ws` | `ws://<host>:7100/dbg/<ticket>/ws` |

   The flow address is a CDP base (discovery at `…/json/list`). For the script debugger it also prints a ready `launch.json` configuration (`type: node`, `request: attach`, `websocketAddress` = the address above, `localRoot` `${workspaceFolder}/src`, `remoteRoot` `/app/projects/<space>`). `<server>` keeps any port of `server` (e.g. `https://localhost:8443`).

The password, the two-step code, the access token and the refresh token are **never printed**; the ticket appears only inside the address. Every new attach (or reconnect) needs a new run — a used or expired ticket is refused.

## Run

```bash
cd agent-runner
npx tsx debug.ts --kind=flow   --project ~/my-flow-project
npx tsx debug.ts --kind=script --project ~/my-flow-project          # + the launch.json configuration
npm run debug -- --kind=script --project ~/my-flow-project --json   # NDJSON
```

| Flag | `.env` | Meaning |
|---|---|---|
| `--kind` | — | `flow` (the flow debugger) or `script` (the script debugger). Required. |
| `--project` | `KEEN_PROJECT_DIR` | the flow project **ROOT** — the folder that holds `.vscode/keen.json` (default `.`). |
| `--json` | — | NDJSON output for the agent. |
| — | `KEEN_MFA_CODE` (environment) | the two-step sign-in code for a run without a terminal — `KEEN_MFA_CODE=123456 npx tsx debug.ts …`. Read once, never printed; 6 digits or exit `2`. A terminal run asks the code instead. |

For a self-signed dev certificate on the sandbox's `https://` address, prefix the command with `NODE_TLS_REJECT_UNAUTHORIZED=0`. A hand-written `launch.json` attach to a `wss://` address needs a certificate VS Code trusts; on a self-signed sandbox use the extension's Start Script Debugger instead.

## Output

```jsonc
{"t":"meta","step":"login","server":"https://keen.example.com","user":"you@example.com"}
{"t":"meta","step":"verify","method":"totp"}   // only with two-step sign-in ("email": also {"t":"meta","step":"resend","sent":true} per new code)
{"t":"meta","step":"ticket","kind":"script","space":"<your-space-id>"}
{"t":"meta","step":"probe","mode":"ports","note":"no debug edge on this server (HTTP 307) — using the port 7100 on keen.example.com"}   // only on an older server
{"t":"attach","kind":"script","space":"<your-space-id>","mode":"edge","url":"wss://keen.example.com/keen-debug/script/dbg/<ticket>/ws","expiresIn":300,"note":"valid for one connection within 5 minutes"}
{"t":"launch","configuration":{"type":"node","request":"attach","name":"Keen Script Debugger","websocketAddress":"wss://keen.example.com/keen-debug/script/dbg/<ticket>/ws","localRoot":"${workspaceFolder}/src","remoteRoot":"/app/projects/<space>", …}}
```

A refusal is one `{"t":"fail","step":"login"|"verify"|"ticket"|"probe","status":…,"reason":"…"}` line:

| Status | Meaning | Fix |
|---|---|---|
| login `406` (or `401`) | bad credentials | check `user` / `password` in `keen.json` — your **console** account, not a consumer |
| login `429` `Too many attempts!` | the sign-in throttle (per address and per e-mail) | wait the time the `reason` names; do not retry in a loop |
| login `202` | the organization requires two-step sign-in and your account has none | set it up in the console (**Account** → **Security**), then run this again |
| verify `406` (or `400`) — the same `bad credentials` reason | a wrong or expired code (or a password that stopped matching) | run this again with the current code |
| verify, no status | two-step sign-in with no terminal and no `KEEN_MFA_CODE`, or no code entered | run it in a terminal, or set `KEEN_MFA_CODE` for that run |
| ticket `403` `Debugger is off` | the switch is off | ask the owner or an admin to switch it on in the console's Debugger page |
| ticket `404` `Space not found` | the `space` in `keen.json` is not a space of this platform | check `space` in `.vscode/keen.json` |
| ticket `406` | the request was refused — `space` is missing or is not a space id | put a real space id in `keen.json` |
| ticket `503` `Spaces channel unavailable` | the platform could not check the space | try again in a minute |
| attach closed `1013` `Debugger in use` | one debugger window per kind at a time | close the other window, then run this again for a new ticket |
| ticket `403` `Forbidden` | no Debugger permission, or not a human account | ask the owner or an admin for a role with the Debugger permission |
| probe `401` / `403` | the debugger refused the ticket | run this again for a new ticket; if it repeats, ask the owner or an admin |
| probe `429` | too many debugger requests from your address | wait a minute |
| probe `5xx` | the debugger is not reachable right now | try again in a minute |

**Exit codes:** `0` the address was printed · `1` refused (login, the code, ticket or probe), or the call failed (network, TLS, HTTP status) · `2` bad arguments / configuration, a `KEEN_MFA_CODE` that is not 6 digits (nothing was sent).

## While a session is open

- A pause that stays at the **same point for 15 minutes** is resumed automatically, whether or not a debugger is attached; any step or resume restarts the clock.
- The owner or an admin can run **Kill debugger connections and resume** on the Debugger page: it ends every debug session and resumes every paused run, without switching the debugger off.
- A session also ends when the debugger is switched off, when your Debugger permission is removed, or when your password changes. Run `debug.ts` again (or start the debugger again in VS Code) to reconnect.
