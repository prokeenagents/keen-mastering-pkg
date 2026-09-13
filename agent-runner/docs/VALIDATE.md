# validate — catch the silent failures before you deploy

`keen-validate` (a compiled **Go** binary) is the **static** first step of the loop. It reads the whole project on disk — every `.flow` file, every `src/scripts/**/*.js`, and `keen-tools.json` — and checks it against the engine + deploy contracts and the canvas form rules. It catches the mistakes that otherwise only surface at runtime as *"No tool response"*, a stalled flow, or a `rejected` deploy — so you spend a deploy + a live run only on code that already passes.

It is a rule-for-rule port of the reference `keen-flow-validator` (`validate.js` + `node-spec.js` + `script-lint.js`) — same findings, same order, same exit codes. The full rule list lives in **`keen-flow-validator/README.md`**.

## What it checks (summary)

- **Project layout & the deploy gate** — `src/flows` with ≥1 `.flow`, no subfolders, no non-`.flow` files (the ms-deploy structure gate rejects otherwise); a VS Code-extension project (`*.flow.json`) is detected and warned, not validated.
- **Structure & node shape** — `{ nodes, edges }`; `id` = `<type>_<12>`; `type` valid + agrees with the id prefix; fixed `labelNode`/`descriptionNode`; `dragHandle`; `position`.
- **Handles & wiring** — every `sourceHandle`/`targetHandle` valid for the type; multi-in rules; `wait` only from a Flow Pointer; required out-handles wired; unwired **Error**/**Fallback** edges warned (script → stall, agent → continues with the error text); reachability from a Start node.
- **Field rules** — Start label from `settings.label` (what the deploy compiler reads), Condition `${…}` wrapping (placeholders stripped, then any bare `dictionary.` = the "Member access is not allowed" throw), Loop refs, key/value caps, script path, `File-Label` targets, agent `agentId`/`llm` (`company` ∈ anthropic/openai/google + a `model`), placeholder roots.
- **Cross-file & tools** — PascalCase flow names; Run/Jump/Parallel targets resolve to a real `File-Label`; script nodes point to an existing file; `keen-tools.json` entries valid + resolvable.
- **Script contract** — the `exec` export (named, not `default`); the import allow-list (`system/*` + relative only, relative targets must exist; no `node:`); the deploy scanner's sandbox rules (no `require`/`eval`/`process`/`global`/`globalThis`/dynamic `import()`/`with`/prototype access — all errors, as the deploy would reject them); a bracket/quote syntax pre-check; and **the agent-reply trigger contract** — every `setRootAgentPrompt`/`setAgentPrompt` reply must carry `sessionID` (a lowercase `sessionId:` key is silently dropped → the *"No tool response"* bug), a `setAgentPrompt` reply must carry `role: 'user'` + `agentChat: true`, and must not reuse the caller's `requestId`.

**Canvas rules vs engine rules.** Some rules (letters-only Start label, no `${…}`/digits in Run Flow targets and `agentId`, key/value caps, fixed card titles) come from the Shira canvas forms and are **stricter than the engines** — the engine would run a `${dictionary.agentID}` agent id; the canvas would not let you author it. They are enforced so the project stays canvas-editable; see the README for which is which.

## Build & run

```bash
# install once — the prebuilt binary for your machine ships in bin/ (see /keen-install);
# maintainers rebuild it from the Go sources in the maintainer repo (keen-flow-validator/go-validate, Go 1.24+)
cp bin/keen-validate-<os>-<arch> ~/.local/bin/keen-validate && chmod +x ~/.local/bin/keen-validate

# run
keen-validate                            # project dir from .env (KEEN_PROJECT_DIR) or "."
keen-validate ./my-flow-project          # explicit dir
keen-validate --json                     # NDJSON for the agent
keen-validate --help
```

Config (flag/arg first, then `.env`):

| Arg / flag | `.env` | Meaning |
|---|---|---|
| `<dir>` or `--project=<dir>` | `KEEN_PROJECT_DIR` | the project **ROOT** (the folder with `src/flows`, `src/scripts`, `src/keen-tools.json`). Default `.`. This is the **same** `KEEN_PROJECT_DIR` value `keen-deploy` uses — one value, both tools. |
| `--json` | — | NDJSON output for the agent. |
| `-h`, `--help` | — | usage. |

**Exit code:** `0` = no errors (warnings allowed — clear to deploy) · `1` = at least one error (fix before deploying) · `2` = usage/IO.

## Output

Human (default) — two lines per finding, sorted errors → warnings → info, then by file (byte order):

```
✗ ERROR  Bad.flow › startNode_aaaaaaaaaaaa
           Start label "start" must match /^[A-Z][a-zA-Z]*$/ (one capitalized word, letters only)
──────────────────────────────────────────
entries (File-Labels) found: Project-Start, Worker-Start
flows: 3 · scripts: 15 · tools: 11
1 error(s), 0 warning(s), 0 info
```

Machine (`--json`, NDJSON — one object per finding, then a summary; key order is not significant, `entries` is `[]` when no Start label was found):

```jsonc
{"t":"error","file":"Bad.flow","where":"startNode_aaaaaaaaaaaa","msg":"Start label \"start\" must match …"}
{"t":"error","file":"scripts/util.js (helper)","where":"","msg":"uses require() — scripts are ES modules; the deploy scanner rejects it as critical (ms-deploy scanner.ts:109-111); use `import`"}
{"t":"summary","errors":2,"warnings":0,"info":0,"flows":3,"scripts":15,"tools":11,"entries":["Project-Start","Worker-Start"],"ok":false}
```

Gate the loop on it: `keen-validate --json` → if the summary's `"ok"` is `false` (or exit code `1`), **fix the errors before `keen-deploy`** — a failed validate means the deploy would waste a round-trip (or the run would fail silently).
