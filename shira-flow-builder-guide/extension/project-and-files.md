# The project — structure, files & multiple flows

Shira is a **VS Code extension**. It scaffolds a project, detects it, deploys it, and debugs it — but it
holds **no** flow/tool/model logic itself (that's the canvas + the engines). This page is the project
layout: what each file/folder is, how to fill the two config files, and how to work across many flows.

---

## What "Create Project" scaffolds

With an **empty** folder open, the panel's **Create Project** button writes this skeleton:

```
.vscode/
  keen.json          ← deploy target (you fill this)
  settings.json      ← {} placeholder
src/
  flows/
    Project.flow     ← { "nodes": [], "edges": [] }  (your first flow)
  scripts/
    init.js          ← export const exec = (props) => { /** Project init script. */ };
    tools/           ← (empty) — home for script-backed tools
  keen-tools.json    ← { "tools": [] }  (the tool registry)
package.json         ← { name, version, private, "type": "module" }
```

Notes (verified against the scaffolder):
- It writes **`init.js`** and an **empty `tools/`** folder — **not** a `tool.js`. (If you see `tool.js`,
  someone added it.)
- It does **not** write a `debux.js` — the debug probe is injected server-side at deploy time.
- **`"type": "module"`** in `package.json` is load-bearing: it makes the `.js` scripts ES modules, which is
  why every script uses `export const exec`.
- `.flow` files open in the **visual canvas** automatically (a custom editor is registered for `*.flow`) —
  `settings.json` needs no association; it's just an empty placeholder.

## The five project markers

A folder is a valid Shira project only if **all five** exist (the panel shows "— detected" when they do):
`.vscode/keen.json`, `src/keen-tools.json`, `package.json`, `src/flows/`, `src/scripts/`.

## The folders — and why they're separated

Structural separation isn't cosmetic — the platform finds things **by convention**, so where a file lives
determines what it *is*:

- **`src/flows/`** — your **flows** (`.flow` files). This folder is **flat**: only top-level, PascalCase
  `*.flow` files (`/^[A-Z][A-Za-z0-9]*$/`). A subfolder here is a warning; a non-PascalCase name is an
  error; **zero `.flow` files is fatal**. **Use letters only** even though digits pass: a node or flow tool
  targets a flow by its `File-Label`, which is letters only, so `Report2.flow` could be an agent's start
  flow but never a Run / Jump / Flow Pointer / Parallel Context target (`keen-validate` warns). (These are the **extension's** checks — they land in the Problems
  panel and keep the panel's Connect / Upload buttons disabled while errors exist. The server-side deploy
  scan does **not** check names; it only requires `flows/` to hold ≥ 1 `.flow` that parses as JSON, plus a
  clean security scan.) Keeping every flow as its own file (not one giant flow) is what
  lets flows **call each other** by name and be reused (see *Multiple flows* below).
- **`src/scripts/`** — the **JavaScript bodies for Script nodes**. A `scriptNode`'s `settings.value` names
  a file here (e.g. `"init.js"`). This folder **is** scanned recursively, so you may organise scripts into
  sub-folders. Script names are `/^[A-Za-z][A-Za-z0-9]*$/`.
- **`src/scripts/tools/`** — the **script-backed tools**. A tool an agent calls whose implementation is a
  script lives here; the engine requires a script-tool's path to be under `tools/`. This is *why the
  `tools/` folder exists* — it's the reserved home that marks a script as a callable tool, separate from
  ordinary Script-node code in `scripts/`.

So: **flow logic → `flows/`, node scripts → `scripts/`, callable tool scripts → `scripts/tools/`.** The
separation is what keeps "a flow", "a script", and "a tool" unambiguous to both you and the engine.

---

## `.vscode/keen.json` — the deploy target

Exactly **three** string fields:

```json
{
  "server": "https://keen.example.com",
  "space":  "<your-space-id>",
  "token":  "<your-deployment-token>"
}
```

| Field | What it is | How to fill |
|---|---|---|
| **`server`** | Base URL of your KeenAgents instance (deploy calls go to `{server}/ms/deploy/v1/project/…`; it's also the **host** the debuggers attach to). | `https://keen.example.com` (your instance's host); `https://localhost` for a local sandbox. |
| **`space`** | The AI **Space id** — **and** the engine's **project id** (your deployed code lives under that id). | Copy the Space ID from the admin console (a `cm…` id). |
| **`token`** | The Space's **deployment token**. | Copy/Reset it on the Space's page in the admin. |

The scaffold writes `[REPLACE_WITH_…]` placeholders; **Connect refuses** to run until you replace all
three with real values. (See *the panel* for Connect/Upload.)

## `src/keen-tools.json` — the tool registry

The scaffold writes `{ "tools": [] }`. You add one entry per tool the agents may call. Each tool, at
runtime, is resolved as **`{ name, type, entry }`**:

| Tool field | What it is |
|---|---|
| **`name`** | The tool's **name** — this is exactly what the LLM puts in `<SYSTEM CALL> !*tool <name>` (see `../tool-calling.md`). |
| **`type`** | **`"flow"`** or **`"script"`** — decides how it runs. |
| **`entry`** | For `type:"flow"` → a **`File-Label`** flow entry (a whole flow runs as the tool). For `type:"script"` → a **path under `tools/`** (e.g. `tools/lookup.js`). |

> The tool's **Description** and **Usage** that the model reads are **not** stored here — you author them
> (in Markdown) into the agent's **System prompt**, as the tool catalogue (see `../tool-calling.md` §5).
> `keen-tools.json` is the *registry* (what exists + how to run it); the *catalogue* (what to tell the
> model) is in the prompt.

*(The exact authoring schema of `keen-tools.json` is finalised by the deploy step server-side; the
`{ name, type, entry }` shape above is what the running engine resolves a tool to.)*

---

## Working with multiple flow files

You rarely build one giant flow. You split logic across **several `.flow` files** and connect them:

- **Each file is one flow**, named in **letters-only PascalCase** (`Project.flow`, `ZigZag.flow`), flat
  under `src/flows/`.
- **Call one flow from another** by its **`File-Label`** address (file name, a dash, a Start node's label):
  - **Run Flow** — run a sub-flow and come back (`nodes/run-flow-node.md`),
  - **Jump Flow** — hand off and finish there (`nodes/jump-flow-node.md`),
  - **Parallel Flows / Parallel Context** — run flows in parallel (`nodes/parallel-flows-node.md`,
    `nodes/parallel-context-node.md`).
- **Multiple entry points per file** — a single `.flow` can hold **several Start nodes**, each its own
  `File-Label` door, so callers can enter the same file at different points (see `example-basic-flow.md`).

**Why split at all?** The same reasons you split code into functions: **reuse** (one flow called from many
places), **clarity** (each file does one job), and **composition** (build big behaviour from small,
testable flows). Because flows are addressed by name, a well-separated project is one where any flow can
call any other — which is impossible if everything is crammed into one file.

## `package.json` & `.vscode/settings.json`

- **`package.json`** — `{ name, version:"0.0.1", private:true, "type":"module" }`. The **`type:"module"`**
  is the important part (ES-module scripts). There are **no deploy npm-scripts** — deploying is the
  extension's **Connect → Upload** over HTTP, or `keen-deploy` (same endpoint) on the building-agent path,
  not `npm run` anything.
- **`.vscode/settings.json`** — an empty `{}`. A placeholder; `.flow` files open in the canvas via the
  registered custom editor, so no file-association is needed here.

---

*Deploying + the panel: `the-panel.md`. Debugging: `debugging.md`. Tool calling: `../tool-calling.md`.*
