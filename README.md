# Keen Mastering

The toolkit **and** the guides for building Keen agent flows — and the loop a building agent (Codex / Claude) runs to build one without touching servers.

> **For the AI reading this:** stay at the flow / product level. Everything you need is the three tools below and the guides in this folder. Each tool prints its own `--help`.

> **The Keen MCP server is your fourth tool — for PROVISIONING, not chatting.** `keen-mcp-guide/` explains how an agent authenticates (an MCP account: id + secret), what it may and may not do, and the golden path to create a space, an agent, the API-access chain and an MCP consumer, then hand the identity to the runner's `.env`. Read it before you touch the admin surface.

> **Shira Flow Builder is not one of your tools.** It's a VS Code extension a human (Shira) uses to build flows in a GUI. The `shira-flow-builder-guide/` folder here documents *how flows work* — drawn from that builder — but you never run the extension. You build a flow by **writing its files** (`src/flows/*.flow`, `src/scripts/`) and shipping them with `keen-validate` → `keen-deploy`. Your `run.ts` is a **communication tool for verification only**: you prompt the deployed agent to check that what you built actually works — it is not how you build.

---

## Start here — the build loop

A flow runs from the platform's **deployed** copy, not your working files. So you can't just edit and re-run — you iterate:

```
edit → keen-validate → keen-deploy → run.ts (prompt + watch) → fix → …
```

```bash
# one-time
cd agent-runner && cp .env.example .env && $EDITOR .env   # space id, tokens, origin, project dir

# each iteration (run from a dir that has .env, e.g. agent-runner/)
keen-validate && keen-deploy && npx tsx run.ts --prompt "build me an offer for ACME" --json
```

- **`keen-validate`** stops you deploying broken code (static: node shapes, wiring, the script `exec` + agent-reply session contracts). `0 error(s)` = clear to deploy.
- **`keen-deploy`** uploads the project; the platform scans + promotes it and answers `deployed` / `rejected` right away.
- **`run.ts`** runs the now-live flow and streams the trace back — live `onStream` progress **and** the flow-tree (which node ran, `request → response`, the LLM answer, any `E….` code).

Every tool reads the same **`.env`** (`agent-runner/.env`), so the loop is just the three commands.

---

## The three tools

| Tool | Where | What / how | Its own docs |
|---|---|---|---|
| **`keen-validate`** | `bin/` (prebuilt) | Go binary — static pre-deploy validator. `keen-validate --help` | `agent-runner/docs/VALIDATE.md` · rules in `keen-flow-validator/README.md` |
| **`keen-deploy`** | `bin/` (prebuilt) | Go binary — the uploader (connect → zip → upload). `keen-deploy --help` | `agent-runner/docs/DEPLOY.md` |
| **`run.ts`** | `agent-runner/` | TypeScript runner — drives the ChatSDK / **TaskQueue** and prints the trace (`npm install` once). `npx tsx run.ts --help` | `agent-runner/README.md` · `agent-runner/docs/USAGE.md` |

`bin/` holds the two binaries for linux / darwin / windows × amd64 / arm64 — nothing to compile. (The distributed package ships binaries only; the Go sources live in the maintainers' working copy.)

**Why two of them are Go:** `keen-validate` and `keen-deploy` are compiled binaries — one file each, **no Node source, no `npm install`, nothing to compile**, and they run the same on Windows / macOS / Linux. Only `run.ts` stays TypeScript, because it drives the **TaskQueue** — the same WebSocket run-orchestration the browser (entanglement / the Shira canvas) uses. That one piece is TS so it can be reused in the browser; everything the browser doesn't need is Go.

### Install the binaries (once — prebuilt, no Go needed)

They ship in `bin/` for six platforms (`linux` / `darwin` / `windows` × `amd64` / `arm64`). Copy the pair for your machine onto your `PATH` under the plain names — `/keen-install` does exactly this — e.g. on Linux x86-64:

```bash
mkdir -p ~/.local/bin
cp bin/keen-validate-linux-amd64 ~/.local/bin/keen-validate
cp bin/keen-deploy-linux-amd64   ~/.local/bin/keen-deploy
chmod +x ~/.local/bin/keen-*
```

The runner needs `cd agent-runner && npm install` once.

---

## What's in this folder

| Folder | What |
|---|---|
| `agent-runner/` | The build loop: `run.ts` (TS runner + ChatSDK/TaskQueue), `.env`, and `docs/` (VALIDATE / DEPLOY / USAGE / TASK-QUEUE / SDK-API). The `keen-deploy` binary lives in `bin/`. |
| `keen-mcp-guide/` | How a building agent operates the Keen **MCP server**: connect (`https://<host>/mcp`), log in as an MCP account, the can/can't rules, the 96 tools by domain, and the provisioning golden path that ends in the runner's `.env`. |
| `keen-flow-validator/` | The static validator's rules: the plain-Node reference (`validate.js` / `node-spec.js` / `script-lint.js`) that defines them. The shipped `keen-validate` binary in `bin/` implements the same rules. |
| `shira-flow-builder-guide/` | The guide to building flows in the Shira canvas — nodes, scripts, the contracts the validator enforces. |
| `shira-flow-builder-notes/` · `shira-flow-builder-hystory/` | Working notes and history behind the guide. |
| `keen-admin-guide/` | The admin console, screen by screen, in plain words (an agent-readable knowledge base for operating the platform). |
| `entanglement-guide/` | The partner reference site's internals — routes, events, the ChatSDK, cookies, errors. |
| `runner-lab-project/` | A flow project a building agent produced end to end with this toolkit (a worked example in the maintainer repo; not shipped in the package). |

Full per-tool instructions live in each tool's docs (table above) and in each binary's `--help`.
