# agent-runner

A headless bridge so a **building agent** (Codex / Claude) can run a Keen flow and **see it happen** — the live `onStream` progress **and** the returned flow-tree (node-by-node `request → response`) — as plain text on stdout. No server access, no browser.

> **For the AI reading this:** stay at the flow / product level — never inspect servers, containers, or infrastructure. Everything you need is here: the two commands, the endpoints you set in `.env`, and the stdout trace they print.

The runner holds the ChatSDK's `onStream` callback and turns every frame into a line of stdout. **That is the hook**: the JS callback lives in the runner, its output is the agent's input.

## THE LOOP — how a building agent iterates

A flow does not run from your working copy — the platform runs the **deployed** version. So a building agent cannot just edit and re-run; the cycle is:

1. **Edit** the flow/script code in your project directory.
2. **Validate** it → `keen-validate` — a static pass over the whole project (node shapes, wiring, the script `exec` + agent-reply session contracts). It catches the silent failures *before* they cost you a deploy and a live run. `0 error(s)` = clear to deploy.
3. **Deploy** it → `keen-deploy` — uploads the project; the platform scans + promotes it and answers `deployed` (or `rejected` with the exact reasons). Only after this is your change live.
4. **Prompt** it → `npx tsx run.ts --prompt "…"` — runs the now-live flow.
5. **Monitor** — read `run.ts`'s output (with `--json` everything is on stdout; in human mode the trace is on stdout and the runner's own notes go to stderr): the live `onStream` progress **and** the flow-tree (which node ran, its `request → response`, the LLM answer, any `E….` error code).
6. **Fix → back to 1.**

The whole config is **nine core values** in **`.env`** — the Keen host, identity (token, user id, email, origin), the one space + agent, the deploy token, and the project dir (plus a few optional ones — `KEEN_CHAT_ID`, `KEEN_COOKIES`, `KEEN_TLS_INSECURE`, `KEEN_PROMPT` — listed in `.env.example`). Fill it once (copy `.env.example`); the three tools read the same file, so each iteration is just the three commands (add `--prompt` to `run.ts`). Every URL derives from `KEEN_HOST` (WS `wss://<host>/ws-keen`, deploy `https://<host>/ms/deploy`). See [docs/VALIDATE.md](./docs/VALIDATE.md), [docs/DEPLOY.md](./docs/DEPLOY.md) and [docs/USAGE.md](./docs/USAGE.md).

```bash
# one-time
cp .env.example .env && $EDITOR .env
# each iteration
keen-validate && keen-deploy && npx tsx run.ts --prompt "build me an offer for ACME" --json
```

`keen-validate` and `keen-deploy` are **compiled Go binaries** — no `npm install`, nothing to compile, one file each (prebuilt in `../bin/`; their Go sources live in the maintainer repo — `go-deploy/` and `keen-flow-validator/go-validate/` — and are not part of the distributed package). Only `run.ts` stays TypeScript because it drives the ChatSDK / **TaskQueue** — the same WebSocket orchestration the browser uses. See **[The tools](#the-tools)** for how to install them.

## The tools

Two of the three steps are **compiled Go binaries** and one is a TypeScript runner. The split is deliberate:

| Tool | Language | Why |
|---|---|---|
| **`keen-validate`** | Go | A static analyzer — no runtime, no browser. Ships as one prebuilt binary, needs no `npm install` and no Go toolchain. |
| **`keen-deploy`** | Go | An uploader (connect → zip → POST). Native `archive/zip` + `net/http`, so Windows/macOS/Linux all work with no external `zip`. One prebuilt binary. |
| **`run.ts`** | TypeScript | Drives the ChatSDK / **TaskQueue** — the same WebSocket run-orchestration the browser (entanglement / Shira canvas) uses. That is the one piece that stays TS; everything the browser doesn't need is Go. |

### Install the binaries (once — prebuilt, no Go needed)

Both ship prebuilt in the package's `bin/` folder for linux / darwin / windows × amd64 / arm64. Copy the pair for your machine onto your `PATH` under the plain names (`/keen-install` does this):

```bash
mkdir -p ~/.local/bin
cp ../bin/keen-validate-linux-amd64 ~/.local/bin/keen-validate   # pick your os-arch
cp ../bin/keen-deploy-linux-amd64   ~/.local/bin/keen-deploy
chmod +x ~/.local/bin/keen-*
```

Both read `.env` from the **current working directory**, so run them from a dir that has your `.env` (e.g. `agent-runner/`), or pass the flags explicitly. Write `.env` values **unquoted** (`KEY=value`): the Go tools keep surrounding quotes literally, while `run.ts` (dotenv) strips them. `keen-validate --json` / `keen-deploy --json` emit NDJSON for machine reading; without `--json` they print a human trace.

### Install the runner

```bash
cd agent-runner     # from the package root (the folder that holds .claude/ and bin/)
npm install         # run.ts + the ChatSDK (TaskQueue) only
```

## Run

```bash
npx tsx run.ts \
  --host keen.example.com \
  --space <spaceId> --agent <agentSlug> \
  --token <consumerAccessToken> --user-id <consumerId> \
  --prompt "build me an offer for ACME" \
  --json
```

- `--host` — the bare Keen host, e.g. `keen.example.com`. The WS endpoint **derives**: `wss://<host>/ws-keen` (for a self-signed cert prefix the command with `NODE_TLS_REJECT_UNAUTHORIZED=0`).
- `--space` `--agent` — the space id and the agent **slug** (not the row id). `projectID` defaults to the space.
- `--prompt` — the user turn.
- `--token` — a consumer `access_token`; this is the **only** auth. There is no login step. Two ways to get one:
  - **Headless (preferred for an agent): the Keen MCP server.** An **MCP account** creates an **MCP consumer** (a headless consumer: id + secret, no email, no password, never an OTP) and calls `get_mcp_consumer_token` with that id + secret → the reply's `access_token` is `KEEN_TOKEN` and the consumer's id is `KEEN_USER_ID`. `KEEN_EMAIL` can be any non-empty value (an MCP consumer has none); `KEEN_ORIGIN` must be the api key's allow-listed origin. See [`../keen-mcp-guide/README.md`](../keen-mcp-guide/README.md).
  - **Browser cookies (a human consumer):** copy the token from the consumer app's browser cookies (DevTools → Application → Cookies). Because its `sub` is sealed, also pass `--user-id <consumerId>`.
- `--chat-id` — reuse ONE stable chat id to continue a conversation (default: a fresh one). **Prefer reusing it** — a fresh id each run spawns a new chat thread and spams the user's chat list; only switch to a new id when the agent goes erratic. Set `KEEN_CHAT_ID` in `.env` to pin it.
- `--json` — NDJSON for machine reading (below). Omit for a human-readable trace.

## What the agent reads (`--json`, NDJSON — one object per line)

```jsonc
{"t":"meta","line":"connect wss://… · space=… · agent=… · chat=…"}
{"t":"stream","event":"token","data":{"text":"Analyzing the offer…"}}                   // live progress (a stream frame carries no requestId)
{"t":"stream","event":"token","data":{"text":"<SYSTEM CALL>load_offers</SYSTEM CALL>"}}
{"t":"meta","line":"run complete — 1 flow bundle(s)"}
{"t":"flow","flowId":"<cid>_<sessionId>_<flowId>","endReached":true,"flowTask":{…},"nodeTasks":[{ /* the node's request */ "flowContext":{…}, "nodeContext":{"kind":"scriptNode","id":"…"}, "response":{ /* output / error code */ } }]}
{"t":"summary","ok":true,"flows":1,"endReached":1}                                      // always last; "error" added when ok is false
```

- `t:"stream"` — every `onStream` frame (engine → user progress, token text, `<SYSTEM CALL>` directives); `event` is one of `thinking` / `processing` / `progress` / `token` / `error`, `data.text` carries the text. The **live** view.
- `t:"flow"` — one per flow bundle in the returned tree; `flowId` is the bundle key `<cid>_<sessionId>_<flowId>`. Each `nodeTasks[]` entry IS the node's request (`flowContext` + `nodeContext` + `options?`) plus its `response` (output / error code). The **structural** view — which node ran, in → out, what failed.
- `t:"flow"` `endReached` — `true` when the flow's End node answered `{ final: true }`; `false` when an unwired output ended it. Exit `0` alone does not tell you the flow reached End.
- `t:"summary"` — the last line: `ok`, how many flow bundles, how many reached End, and `error` on a failure (the partial tree is printed before it).
- Credentials are printed as `"<redacted>"` (the SDK stamps the live `access_token` on every bundle), and stdout holds only these lines — SDK console output goes to stderr.
- `t:"meta"` — runner notes (connect, completion, failures). Exit code `0` the run settled · `1` failed run · `2` bad args · `130` cancelled with Ctrl+C.

## The two channels

| Need | Channel |
|---|---|
| The agent **drives** the run and wants the full node/dict/error trace | **this runner** (Client API / ChatSDK) — synchronous, complete |
| Watch runs the agent did **not** trigger, or ambient `Log.*` tails | **Keen's live log stream** — dev sandbox: `WS ws://<keen-host>:5540/monitor/stream/<space>/<agent>?token=<readToken>` (ms-monitor's published port; the read-token rides the `token` query, a bad one is refused with a plain 401 before the handshake). **Production has no external route for it yet** — the nginx edge does not proxy `/monitor/`, so a `wss://<host>/monitor/…` URL lands on the admin UI. |

## Three things the environment must give you

1. **An allow-listed `--origin`.** The relay's allow-list is the set of origins on the **webhook records bound to fully-bound api_keys** (key + client + certificate + contract + webhook; exact match; a missing `Origin` is refused — and a Node client sends none). An Origin not on it gets the upgrade refused (`Unexpected server response: 502` through the nginx edge). Pass `--origin <your partner site's origin>` — the origin on the webhook record bound to its api key. The token's `origin` claim must match it too.
2. **A valid consumer `--token`.** Token is the only auth — there is no login step. The headless way: an MCP account creates an **MCP consumer** and calls `get_mcp_consumer_token` on the Keen MCP server → its `access_token` is `KEEN_TOKEN` and the consumer's `id` is `KEEN_USER_ID` (see `../keen-mcp-guide/README.md`). The manual way: copy the consumer `access_token` from the consumer app's browser cookies (open the app logged in as the consumer → DevTools → Application → Cookies) and set `KEEN_TOKEN`. An **absent** token → the runner prints both ways (MCP first) and exits `2`; a **wrong/expired** token → `run FAILED: Invalid token` (the Keen server, E3002).
3. **`--user-id <consumerId>`.** The consumer token seals its `sub`/`email` inside `hash` (only the Keen server's cert secret opens it), so the runner cannot read them. The Keen server enforces `userContext.userId === token.sub`, so pass the consumer's id explicitly. **`--email` is presence-only** — the Keen server requires it non-empty but does not match it, so any value works (default: the token's `email` claim if present, else pass one).

**Verified end-to-end:** a real consumer token + allow-listed origin + `--user-id` ran a full flow against `agent-one` — the runner streamed the live tokens ("Hello! How can I help you today?") and printed the whole flow-tree: `startNode → scriptNode(init.js) → agentNode(AgentOne, anthropic/claude-opus-4-5) → endNode(final)`, each node with its `request → response`. Exit 0.

The SDK under `sdk/` is functionally identical to entanglement's ChatSDK (comment-only drift; `KeenChat` + `HOW_TO_USE` not included) — zero project imports, so it lifts out as-is at runtime. Its `App.Chat.*` ambient types live in entanglement's `src/@types/chat.d.ts`, which this package does not ship (`tsx` runs it untyped).
