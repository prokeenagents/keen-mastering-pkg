# Keen Flow Validator (static)

A deterministic, dependency-free static validator for a Keen flow project. It checks a project's
`.flow` files, scripts, and `keen-tools.json` against the engine + deploy contracts (and the canvas
form rules) **before deploy** — catching the silent failures that otherwise only surface at runtime
as *"No tool response"*, a stalled flow, or a rejected deploy.

This is the **static half** of the self-building feedback loop (see `shira-flow-builder-guide/`): an LLM
that authors a flow can run this to catch most mistakes at compile time, before ever touching the engine.
The **dynamic half** (deploy → run a test chat → read the platform's logs → classify) is `agent-runner/`.

## Usage

Two builds, **the same rules** — same findings, same order, same exit codes:

- **`keen-validate`** — a compiled **Go** binary, shipped prebuilt in `bin/` for six platforms. This is the form the building agent runs: one static binary, no Node, no source on disk (its Go sources, `go-validate/`, live in the maintainer repo and are not part of the distributed package). It is a rule-for-rule port of the JS below and its human trace is diff-identical to it (no lookbehind/lookahead anywhere, byte-order sorting, the same string-aware comment stripper).
- **`validate.js`** — the plain-Node reference implementation and source-of-truth for the rules. It takes only `<project-dir>` (the `.env` / `--project=` / `--json` conveniences below are Go-only).

```bash
# Go binary — prebuilt in bin/ (installed by /keen-install; maintainers rebuild from go-validate/ with Go 1.24+)
cp bin/keen-validate-<os>-<arch> ~/.local/bin/keen-validate && chmod +x ~/.local/bin/keen-validate
keen-validate <project-dir>            # or: keen-validate  (dir from KEEN_PROJECT_DIR / .env)
keen-validate <project-dir> --json     # NDJSON — one object per finding + a summary
keen-validate --help

# JS reference (no install, plain Node.js)
node validate.js <project-dir>
```

- `<project-dir>` is the project root (the folder containing `src/flows`, `src/scripts`, `src/keen-tools.json`) — the **ms-deploy** layout that `keen-deploy` uploads raw. The Go binary also reads `KEEN_PROJECT_DIR` from a `.env` in the working dir, defaulting to `.`.
- Prints each finding as two lines (`✗ ERROR  <file> › <where>` then the message), then a summary + the list of entry `File-Label`s it found.
- **Exit code:** `0` = no errors (warnings allowed), `1` = at least one error, `2` = usage/IO error.
- A **VS Code-extension** project (`src/flows/*.flow.json`, per-flow folders, a root `keen-tools.json`) is a different format, built by `keen-builder` into `dist/`. The validator detects it and emits one WARN — its flows are **not** validated here (its scripts still are).

Both are the **static** first step of the agent build-loop (`agent-runner/` → `keen-validate` → `keen-deploy` → `run.ts`); see `agent-runner/docs/VALIDATE.md`.

## Canvas rules vs engine rules

Two kinds of rule are enforced, and it matters which is which:

- **Engine / deploy rules** mirror what the engines and the ms-deploy build actually do — a violation fails at deploy or at run time.
- **Canvas rules** mirror the Shira canvas forms (`shira-flow-builder-guide/field-rules.md`). They are **stricter than the engines**: the engine resolves `${dictionary.*}` in an `agentId` or a Run Flow target and accepts digits in a Start label, but the canvas forms do not. They are enforced as errors so an authored project is also editable on the canvas; a hand-authored, deploy-only project may legitimately hit them. Marked **[canvas]** below.

## What it checks

**Project layout & the deploy gate** (ms-deploy `build-project.ts` + `structure-scanner.ts`)
- `src/flows` exists and holds **≥1 `.flow`**; **no subfolders** and **no non-`.flow` files** in it (a stray file
  survives the server-side build and the deploy is rejected with "flows must contain only .js files").
- `src/scripts` missing → warning only (the deploy creates it); `src/keen-tools.json` missing → warning.
- A `src/scripts/debux.js` is warned and skipped — the deploy injects the engine's own copy over it.

**Structure & node shape**
- `.flow` is `{ nodes, edges }` (flags stray top-level keys).
- Node `id` = `<type>_<12 A–Za–z0–9>`; `type` valid and agrees with the id prefix.
- Fixed `data.labelNode` / `data.descriptionNode` per type (must match exactly) **[canvas]**.
- `dragHandle` = `.drag-handle__custom`; `position {x,y}` present (warnings) **[canvas]**.

**Handles & wiring**
- Every edge's `sourceHandle` / `targetHandle` is valid **for that node type** (from the handle spec).
- **Multi-in** rules — `in` is single-in on condition/assignment/parallelContext (and the loop's `next_2`),
  multi-in elsewhere; `wait` accepts **only** Flow Pointer sources.
- **Required out-handles wired** — a node whose out dead-ends is warned (e.g. condition `true`+`false`,
  loop `out`+`next_1`, agent/script `next_1`).
- **Recommended failure edges** — an unwired **Error** (Script) or **Fallback** (agent/LLM) edge is warned,
  with the real consequence per engine: a script throw with no `error` edge **stalls** the flow; an agent
  provider failure with no Fallback **continues on `next_1` with the error text as the answer**.
- **Reachability** — every runnable node should be reachable from a Start node (warning).
- Edge `type` should be `"step"`.

**Field rules**
- **Start label** — read from `settings.label` (the deploy compiler builds the entry map from `settings.label`
  ONLY); a `settings.value`-only label is accepted with a warning naming the fix. Must match
  `^[A-Z][a-zA-Z]*$` ≤60 **[canvas]** (ms-space also allows digits).
- **Condition** — `${dictionary.*}`/`${session.*}` placeholders are stripped first, then any bare `dictionary.` /
  `session.` left over is an error (the engine throws "Member access is not allowed").
- **Loop** `value`/`setto` need the `dictionary.`/`session.` prefix (optional `${…}` wrapper, as the engine's
  parser) and must differ **[canvas]**.
- **Assignment/Script** key-value caps (≤10 pairs, key ≤100, value ≤200, no dup keys) **[canvas]**; Script path
  ends `.js` **[canvas]**.
- **Run/Jump/Flow-Pointer** targets = `File-Label` (`^[A-Z][a-zA-Z]*-[A-Z][a-zA-Z]*$`, no digits, no `${…}`)
  **[canvas]** — the engine itself would resolve a `${…}` target; **Parallel Context** `contextCollection` starts
  `dictionary.`, `pipe` = `File-Label` (the engine does NOT interpolate `pipe`).
- **Agent** `agentId` kebab-case letters-only **[canvas]** (the engine resolves `${…}`); `agentName` present;
  `settings.llm` block present with **`company` ∈ {anthropic, openai, google}** (case-insensitive) and a
  **`model`** — the llms-engine throws E6101 otherwise; Note ≤160 **[canvas]**.
- Placeholder roots other than `${dictionary.*}` / `${session.*}` are warned — they stay **literal** text (and
  throw inside a Condition).

**Cross-file & tool registry**
- Flow file names are PascalCase (`^[A-Z][A-Za-z0-9]*$`, the ms-space `startFlow` rule); builds a registry of every
  `File-Label` (each flow's Start labels, as the deploy compiler builds it).
- Run / Jump / Parallel Flow / Parallel Context targets resolve to a real `File-Label`.
- Script nodes point to an existing file under `src/scripts/`.
- `keen-tools.json`: `{ "tools": [ { name, type, entry } ] }`; unique names; `script` entry under `tools/`
  (no `..`) and the file exists; `flow` entry is a `File-Label` that resolves.

**Script-contract lint (`script-lint.js`)** — a light, dependency-free lexical pass over every
`src/scripts/**/*.js` (scripts are **JavaScript only** — the engine is a bare V8 isolate, only `.js` is
scanned/deployed):
- **Syntax pre-check** — bracket/quote balance over comment- and literal-stripped code (the deploy scanner
  rejects any script that does not parse; this is not a full parser).
- **`exec` export** — an entry script (a Script node's file or a registered tool) must export a NAMED `exec`
  (`export const|let|var|function exec`, or `export { exec }`), not `export default`. Helper modules
  imported relatively are exempt.
- **Imports** — only `system/*` (the nine modules) and relative `./`/`../` files; `system/logs` →
  `system/log`; no npm packages / absolute paths / `node:` (the runtime resolver rejects `node:` even though
  the deploy scanner whitelists two). A relative import's **target must exist** under `src/scripts` by exact
  path (no extension inference) and must not escape it.
- **Sandbox rules** (mirror of the deploy scanner, ms-deploy `scanner.ts`, all errors): `fetch()`; any
  reference to `eval` / `Function` / `require` / `process` / `global` / `globalThis` / `module` / `exports` /
  `__dirname` / `__filename`; dynamic `import()`; `with`; `.__proto__` / `.constructor` / `.prototype` /
  `getPrototypeOf` … access or assignment. `crypto.` is a warning (no crypto in the isolate — use
  `Tools.generateUUID()`).
- **The agent-reply trigger contract (the "No tool response" bug)** — every `setRootAgentPrompt` /
  `setAgentPrompt` reply must carry **`sessionID`** (else the agent's session-scoped trigger can't see it);
  a lowercase **`sessionId:`** KEY is an error (silently dropped) — matched in key position only, never a
  value such as `sessionID: sessionId`; a `setAgentPrompt` reply must also carry **`role: 'user'` +
  `agentChat: true`** (the engine's trigger predicate; `setRootAgentPrompt` bakes them); stamping
  **`requestID`** with the caller's own request id (`toolOptions.agentNode.flowContext.requestId`) is an
  error (the engine detects a reply by that id changing); a fresh `requestID: Tools.generateUUID()` is
  recommended; a script **tool** that stamps `flowContext.sessionId` (its own session, not the caller's) is
  warned.
- **Concurrency** — `Promise.all` over reads of `system/http`, `system/agent` or `system/dictionary` (bound to
  the file's actual import bindings, e.g. `AgentMgr`) shares one buffer → warned (E_SAB_BUSY).
- **Tool sanity** — a script tool that replies but never reads `toolOptions.toolContext` / a caller session.

## What it deliberately does NOT check (yet)

- **Runtime behavior** — whether the provider call succeeds, whether the answer is correct, whether a
  live tool loop returns. That's the **dynamic** validator's job.
- **A real JS parse** — the syntax pre-check is bracket balance, not a parser; the model name is not checked
  against the provider's registry.
- **Deep dataflow** — the script lint is lexical (regex + balanced-bracket), so it reasons per
  `setRootAgentPrompt` call, not across variables (one-hop aliases of the caller's request id are followed).
  It catches the common shapes; a subtle indirection (payload built in a distant variable) may slip through.

## The spec is the source of truth

All node rules live in **`node-spec.js`** — the node types, fixed labels, handle sets, multi-in rules,
the per-engine failure-edge texts, the supported LLM providers, and the field regexes/caps. Keep it in
lockstep with the platform: the React Flow node components, the engine node logic, and ms-deploy's
`builder/flow-compiler.ts`. If a node or rule changes there, update `node-spec.js` AND the Go port (`go-validate/main.go` in the maintainer repo), then rebuild `bin/`.

## Roadmap

1. **(done) Static flow validator** — `validate.js` + `node-spec.js`.
2. **(done) Script-contract lint** — `script-lint.js`, integrated into `validate.js`.
3. **(done) Go build** — `keen-validate`, a rule-identical static binary the agent runs (prebuilt in `bin/`; sources in the maintainer repo).
4. **(done) Dynamic half** — `agent-runner/` deploys (`keen-deploy`) and runs a real chat (`run.ts`),
   streaming the flow-tree + `E….` codes back to the agent on stdout.
5. **Auto-classification** — turn that stdout trace into a structured pass/fail verdict, fully closing
   the self-building loop.
