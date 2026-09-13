# agent-runner — usage

A headless bridge so a **building agent** (Codex / Claude) — or you — can run a Keen flow and **see it happen**: the live `onStream` progress **and** the full flow-tree (every node, `request → response`), as plain text on stdout. No server access, no browser.

The runner holds the ChatSDK's `onStream` callback and turns every frame into a line of stdout. **That is the whole trick** — the JS callback lives in the runner; its output is the agent's input.

## What it's for

- **Iterating on a flow/agent.** Change a script, redeploy, run it here, read the node-by-node trace (which node ran, its input, its output, the LLM provider/model/tokens, any error code), fix, repeat — a tight closed loop the agent drives itself.
- **Not** for passively watching runs you did not trigger, or tailing ambient `Log.*` in production — that is [Keen's live log stream](#the-two-channels).

## Install

```bash
cd ~/Desktop/"Keen Mastering"/agent-runner
npm install
```

## Quickstart

```bash
npx tsx run.ts \
  --host keen.example.com \
  --origin https://<allow-listed-origin> \
  --space <spaceId> --agent <agentSlug> \
  --user-id <consumerId> \
  --token <consumerAccessToken> \
  --prompt "Say hello in one short sentence." \
  --json
```

Everything but `--prompt` is normally set once in `.env` (see `.env.example` — nine core values plus a few optional ones; write values unquoted); each run is then just `npx tsx run.ts --prompt "…"`. The WebSocket endpoint is **derived** from `KEEN_HOST` (`wss://<host>/ws-keen`); `projectID` defaults to `KEEN_SPACE_ID`.

A successful run prints the live tokens, then one `flow` line per bundle, then exits 0.

## Flags

| Flag | `.env` | Meaning |
|---|---|---|
| `--host` | `KEEN_HOST` | The bare Keen host, e.g. `keen.example.com` (no scheme, no path). The WS endpoint **derives**: `wss://<host>/ws-keen`. For a self-signed cert prefix `NODE_TLS_REJECT_UNAUTHORIZED=0`. **Local stack:** `KEEN_HOST=localhost` → `wss://localhost/ws-keen` through the nginx edge (self-signed → `NODE_TLS_REJECT_UNAUTHORIZED=0`); there is no flag for a raw `ws://…:5520/ws` relay URL — scheme and path are fixed. |
| `--origin` | `KEEN_ORIGIN` | **Required in practice.** Must be an origin the api_key allows — the Keen server silently drops any other (a Node client sends none). |
| `--space` | `KEEN_SPACE_ID` | The space id. |
| `--agent` | `KEEN_AGENT` | The agent **slug** (e.g. `agent-one`) — NOT the row id. |
| `--token` | `KEEN_TOKEN` | A consumer `access_token` — the **only** auth (there is no login step). **Headless way (the Keen MCP server):** an MCP account creates an **MCP consumer** (id + secret, no email/password, never an OTP) and calls `get_mcp_consumer_token` (id + secret) → `access_token` = `KEEN_TOKEN`, and the consumer's id = `KEEN_USER_ID`; `KEEN_EMAIL` can be any non-empty value (an MCP consumer has none); `KEEN_ORIGIN` must be the api key's allow-listed origin — see [`../../keen-mcp-guide/README.md`](../../keen-mcp-guide/README.md). **Alternative (a human consumer):** copy the token from the consumer app's browser cookies. |
| `--user-id` | `KEEN_USER_ID` | **Required for a consumer token** — its `sub` is sealed in the token's `hash` (only the Keen server opens it), and the Keen server enforces `userId === sub`. Pass the consumer's id. |
| `--email` | `KEEN_EMAIL` | Presence-only (the Keen server requires it non-empty but does not match it). Defaults to the token's `email` claim if present; otherwise pass any value. |
| `--prompt` | `KEEN_PROMPT` | The user turn (per-run; `KEEN_PROMPT` is read as a fallback, but a prompt is normally not pinned in `.env`). |
| `--chat-id` | `KEEN_CHAT_ID` | Reuse to continue **one** conversation (default: a fresh id). **Prefer a stable id** — see *Continuing a conversation* below. |
| `--cookie name=value` | `KEEN_COOKIES` | A cookie the flow's script nodes should see (repeatable), read via `system/cookies`. |
| `--json` | — | NDJSON output (machine). Omit for a human-readable trace. |

`projectID` is not a flag or a var — it defaults to `--space` / `KEEN_SPACE_ID` (space id === project id).

## Output contract (`--json`, one JSON object per line)

```jsonc
{"t":"meta","line":"ready — cid 49dece98-…"}                       // lifecycle notes
{"t":"stream","event":"token","data":{"text":"Hello"}}             // live progress — one per onStream frame
{"t":"stream","event":"token","data":{"text":"<SYSTEM CALL>load_offers</SYSTEM CALL>"}}
{"t":"meta","line":"run complete — 1 flow bundle(s)"}
{"t":"flow","flowId":"…","flowTask":{…},"nodeTasks":[ /* each: request + response */ ]}
```

- `t:"stream"` — every `onStream` frame (engine → user progress; token text; `<SYSTEM CALL>` directives). The **live** view.
- `t:"flow"` — one per flow bundle in the returned tree. Each `nodeTasks[]` entry carries the node's `nodeContext` (`kind`/`id`), its request, and its `response` (the output, or an `E….` error code). An `agentNode` response also carries the LLM `provider`/`model`/`usage`/`finishReason` and the answer `text`. The **structural** view — which node ran, in → out, what failed.
- `t:"meta"` — runner notes. **Exit code**: `0` success · `1` run failed · `2` bad args · `130` cancelled (Ctrl+C).

Human mode (no `--json`) prints the same information as an indented, readable trace — the stream/flow lines on stdout, the runner's `meta` notes on **stderr**.

## Continuing a conversation (chat id)

Reuse **one** stable chat id across runs — set `KEEN_CHAT_ID` in `.env` (or pass `--chat-id`) and keep it. Every run then **continues the same thread**, so the agent keeps its conversation context and your chat list stays clean.

If you leave it unset, `run.ts` mints a **fresh** id each run — a brand-new chat thread every time, which **spams the user's chat list** and drops all prior context. When that happens the runner prints a one-line hint with the minted id so you can pin it:

```
agent-runner: fresh chat id minted — set KEEN_CHAT_ID=run-… (or --chat-id run-…) to keep continuing THIS thread on the next run instead of spawning a new chat each time
```

Switch to a **new** id only when the agent starts behaving erratically / incoherently — a fresh session resets the conversation context and gives it a clean slate.

## Stopping a flow

- **Ctrl+C (SIGINT)** — the runner calls `sendCancel(cid)`, which tells the Keen server to wipe this run's `dict` / `session` / `agentState` / queue, then disconnects and exits `130`. A half-run leaves **nothing** behind. A second Ctrl+C hard-exits immediately.
- Programmatically (own client): `chat.sendCancel(correlationID)` — see [SDK-API.md](./SDK-API.md#stopping-cancel).
- Killing the process WITHOUT cancelling (e.g. `kill -9`) still ends the flow: closing the socket makes the Keen server cancel this connection's cid on the engines (its disconnect handler fires the same cancel). Ctrl+C is still preferred — an explicit cancel plus a clean exit `130`.

## The two channels

| Need | Channel |
|---|---|
| The agent **drives** the run and wants the full node/LLM/error trace | **this runner** (Client API / ChatSDK) — synchronous, complete, zero-instrumentation |
| Watch runs the agent did **not** trigger, or ambient `Log.*` tails | **Keen's live log stream** — dev sandbox: `WS ws://<keen-host>:5540/monitor/stream/<space>/<agent>?token=<readToken>` (ms-monitor's published port; the read-token rides the `token` query, a bad one is refused with a plain 401 before the handshake). **Production has no external route for it yet** — the nginx edge does not proxy `/monitor/`, so a `wss://<host>/monitor/…` URL lands on the admin UI. |

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `run FAILED: welcome timeout (origin allow-listed? relay up?)` after ~15 s | The Keen server never sent its `welcome`. Almost always an Origin that is not allow-listed (the server drops the socket silently before the handshake) → pass the api_key's `--origin`; otherwise the server is unreachable or `--host` / `KEEN_HOST` is wrong. |
| `run FAILED: Invalid token` | Bad/expired token → supply a valid consumer `--token`. |
| `userContext.userId does not match token subject` | Missing/wrong `--user-id` → pass the consumer's id (= the sealed `sub`). |
| `Missing userContext.userId / userContext.email` | Pass both `--user-id` and a non-empty `--email`. |

The `sdk/` folder is functionally identical to entanglement's ChatSDK (comment-only drift; `KeenChat` + `HOW_TO_USE` not included) — zero project imports. Its `App.Chat.*` ambient types live in entanglement's `src/@types/chat.d.ts` (not shipped here; `tsx` runs the SDK untyped).
