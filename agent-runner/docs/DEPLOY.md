# deploy — push flow/script code live

`keen-deploy` (a compiled **Go** binary) is the **uploader** half of the loop. A flow runs from the platform's **deployed** copy, not your working files, so a building agent must deploy an edit before it can run it. This speaks the Keen deploy endpoint's protocol directly, in pure Go stdlib (no Node, nothing to compile — prebuilt in `../bin/`). `deploy.ts` is the TypeScript reference of the same protocol (it has no `--insecure`; with a self-signed cert run it under `NODE_TLS_REJECT_UNAUTHORIZED=0`); the binary is what you run. Both take `--key value` or `--key=value` and `-h` / `--help`.

## What it does (synchronous — one call, one verdict)

1. **connect** — `POST https://<host>/ms/deploy/v1/project/connect` with the deployment token + space → a short-lived session token (default TTL 5 min, returned as `expiresIn` seconds). The platform holds ONE live deploy connection: a connect for another space evicts it; a repeat connect for the same space keeps the session and extends the TTL.
2. **zip** — `KEEN_PROJECT_DIR` is the project **ROOT**; the tool packs the CONTENTS of its `src/` in memory (Go's native `archive/zip`, so Windows/macOS/Linux all work with no external `zip`) so `flows/` + `scripts/` land at the zip root. (If the root has no `src/`, it zips the root's contents — back-compat.) **Only what the platform builds is uploaded:** `flows/`, `scripts/` and `keen-tools.json` at the top; every other top-level entry is left out and named in the `zip` line's `skipped`, and dot-entries (`.env`, `.vscode/keen.json`, `.git` …), `node_modules` and stray `*.zip` files are skipped at any depth. A directory without `flows/` is refused **before anything is sent** (exit 2) — so pointing the tool at the wrong folder (e.g. `agent-runner/` itself, with its `.env`) can never upload secrets.
3. **upload** — `POST /v1/project/upload` (multipart, field `bundle`). The platform **builds (compiles your `.flow` files), checks the structure, scans and promotes it, and answers right away** — no polling.
4. **disconnect** — best-effort.

## Install & run

```bash
# install once — prebuilt, no Go toolchain; pick your os-arch from ../bin/
# (linux / darwin / windows × amd64 / arm64)
mkdir -p ~/.local/bin
cp ../bin/keen-deploy-linux-amd64 ~/.local/bin/keen-deploy && chmod +x ~/.local/bin/keen-deploy

# run (from a directory that has your .env, e.g. agent-runner/)
keen-deploy                              # all config from .env
keen-deploy --project ./my-flow-project --json
```

Config (flag first, then `.env` in the working dir — write values **unquoted**: the Go binary keeps surrounding quotes literally, unlike `run.ts`'s dotenv):

| Flag | `.env` | Meaning |
|---|---|---|
| `--host` | `KEEN_HOST` | the bare Keen host, e.g. `keen.example.com`. The deploy base **derives** from it: `https://<host>/ms/deploy` (the tool appends `/v1/project/*`). |
| `--space` | `KEEN_SPACE_ID` | the AI space id. |
| `--deploy-token` | `KEEN_DEPLOY_TOKEN` | the space's deployment token (Admin console → the space). |
| `--project` | `KEEN_PROJECT_DIR` | the flow project **ROOT** (the folder that contains `src/`; default `.`). Deploy zips `<root>/src` so the same value also works for `keen-validate`. |
| `--insecure` | `KEEN_TLS_INSECURE` | skip TLS verification (for a self-signed dev cert); `KEEN_TLS_INSECURE=true` (or `1`). |
| `--json` | — | NDJSON output for the agent. |

## Output

```jsonc
{"t":"meta","step":"connect","base":"https://<host>/ms/deploy","space":"<space>"}
{"t":"meta","step":"connected","session":"b9946d53…"}
{"t":"meta","step":"zip","root":"<abs project root>","zipping":"<abs project root>/src","skipped":["README.md"]}   // skipped: only when something was left out
{"t":"meta","step":"upload","bytes":130}
{"t":"deployed","project":"<space>","generation":3}                 // success — exit 0
```
On failure:
```jsonc
{"t":"rejected","error":"Deployment rejected","message":"… 2 issue(s) …","issues":[ … ]}      // security scan
{"t":"rejected","error":"Invalid project structure","message":"…","reasons":["flows/ directory is missing"]}
{"t":"fail","step":"connect","status":403, …}                        // bad deploy token / space (401 = a header missing · 503 = platform still bootstrapping)
{"t":"fail","step":"upload","status":409, …}                         // a newer upload for the same space superseded this one
{"t":"fail","step":"request","error":"fetch failed: …"}              // deploy.ts: network / TLS failure (keen-deploy reports it as status 0)
```
Exit code: `0` deployed · `1` rejected / failed (including a network or TLS failure) · `2` bad args or a directory without `flows/` (nothing was sent).

## What the project must contain (the scan)

You upload your **raw `src/`** — the source you author, not a build output. Under `KEEN_PROJECT_DIR` (the ROOT):

- `src/flows/` — your flow files, `*.flow` (**required** — at least one);
- `src/scripts/` — your script files, `*.js` (the platform creates the folder if it is absent, but `keen-validate` expects it);
- `src/keen-tools.json` — the tool manifest (optional; `keen-validate` warns when it is missing).

`init.map.js` (from `keen-tools.json`), each `<Name>.flow.js` + `<Name>.flow.map.js` (from `<Name>.flow`) and the engine's `debux.js` are **produced by the platform server-side** from your source during the deploy — they are **NOT** something you author or ship; the raw `.flow` files and `keen-tools.json` are consumed by the build and do not remain in the live tree. The upload must also pass the **security scan** (the `issues` array names what to fix).

A `rejected` with `reasons`/`issues` is the platform telling you exactly what to change before the deploy takes — read them, fix, deploy again.

**Verified end-to-end:** connect authenticates with a real deployment token, the zip uploads, and the platform returns its structured verdict (a throwaway dir correctly came back `Invalid project structure — flows/ directory is missing`).
