# Shira Flow Builder — Author's Guide

**An agent-readable guide to building Keen agent flows with Shira.** Point any AI assistant at this folder
and it can walk a developer — even a first-timer — through building a flow: what the pieces are, what each
node does, how data moves, how to call tools, how to debug, and how to deploy so a Keen agent runs it.

Shira is the **Keen visual flow builder** — a VS Code extension whose canvas (a React Flow board) is where
you draw a flow as boxes (nodes) wired together. Companion to the admin guide (`keen-admin-guide/`): the
admin guide *deploys and debugs* a built flow; this one is about *building* it.

---

## For the AI assistant reading this

**Shira is a human's GUI — you write what it would produce.** Shira (the VS Code canvas) is how a *person* builds a flow: dragging node boxes and wiring them on a board. You never run it. Your job is to produce the **same artifacts by hand** — the `.flow` files, their nodes and their wiring — written as text, so that what you save is exactly what Shira would have saved from the canvas. So read every node page below as *"this is what Shira produces for this node"*, and write the file to match: `field-rules.md` is the shape the canvas would accept, and `minimal-agent.md` is a complete example of that output. You then ship it with the agent-runner tools (`keen-validate` → `keen-deploy`) and verify by prompting the deployed agent with `run.ts` — that runner is for checking what you built, not for building.

**Stay at the flow / product level — never inspect servers, containers, or infrastructure.** Everything you need to build, deploy, and debug a flow is here: the nodes and how they wire, the data model (dictionary / session / conversation), and the admin console described in these pages. If a flow misbehaves, the answer is in the flow (the nodes, the data objects, the logs it writes) — not in the platform's internals.

**Assume the person may have never built a flow before.** Many will ask the simplest questions — *"what's a
node?", "how do I connect two boxes?", "where do I type the prompt?", "why won't my agent run?"* — and
that's exactly who this is for.

- **They have the initiative but not the map — lead them.** When someone wants to build a flow but can't orient (they hand you a goal, not a plan, or don't know which piece they need next), don't wait for a precisely-formed question: take the lead and suggest the concrete next step — *which* node to add and *how* to do it, which file to write, what to type — translating their intent (*"an agent that answers questions about our returns policy"*) into the pieces (Start → Agent → End, the prompt, any tool), one confirmed step at a time.
- Define every term the first time (node, edge, dictionary, session, conversation).
- Give one concrete action at a time; confirm, then the next.
- **Never invent a flow name or node name.** A flow's file name and its Start node must **exactly match**
  the **Start Flow / Start Node** set on the agent in the admin (PascalCase, exact) — a made-up name saves
  but the agent never runs. Use **letters only** in flow file names: a digit passes as a Start Flow, but no
  node or flow tool can then target that flow (`field-rules.md`).
- **Verify against the source, don't guess.** This guide was written against the engine + canvas code; keep
  it that way when you extend it.
- Walk them to a **working end-to-end** result, not just a diagram.

**If asked to build one:** the smallest working answering agent is `minimal-agent.md` (a ready-to-use
`.flow`). Follow `field-rules.md` so the file is one the canvas will actually accept.

---

## Mental model (read this once)

- A **flow** is a **graph of nodes** wired by **edges**, drawn on the **canvas**. It's the step-by-step
  logic an agent runs.
- Execution **starts at a Start node** (chosen by its `File-Label`) and follows the wired **output dots**
  to an **End** node. Each dot has a **handle id** that an edge names (`next_1` for most out dots, `in`
  for most inputs); the deploy compiler renames the few canvas-only ids (`next`, `true` / `false`, `out`)
  onto the engine's `next_1` / `next_2` keys — write the canvas ids (`field-rules.md` → *Handle ids*).
- **Edges carry control, not data.** Data lives in shared objects: the **`dictionary`** (per-flow),
  the **`session`** (whole-run), and the **conversation** (agent messages). A node *writes* a value; a later
  node *reads* it. (This is the key idea — see `business-objects.md`.)
- Flows **compose**: **Run Flow** calls a sub-flow, **Jump Flow** hands off, **Parallel Flows** / **Parallel
  Context** run flows at once.
- **Workflow — two paths to the same files.** A *person* opens Shira in VS Code → draws + configures on
  the canvas → **deploys** with the panel (Connect → Upload) → **debugs** on a **sandbox**. A *building
  agent* (you) writes the same `.flow` / script / `keen-tools.json` files by hand → `keen-validate` →
  `keen-deploy` (the same deploy endpoint the panel calls) → prompts the agent with `run.ts` and reads the
  logs. Either way the agent, pointed at your flow's name + start node, runs it. The pages under
  `extension/` describe the human path.

---

## "I want to…" → read this

| Goal | File |
|---|---|
| Understand the pieces in plain terms (flow, node, the data objects) | `business-objects.md` |
| Follow the life of a run (start → receive → evolve → exit → die) | `flow-lifecycle.md` |
| Know the data exactly (dictionary / session / agent-state, `${…}` rules) | `data-model.md` |
| Learn what each node does | `nodes/` (list below) |
| Configure an **Agent** node (model, prompt, tools) | `nodes/agent-node.md` |
| Write a **Script** node | `nodes/script-node.md` |
| Make an agent **call a tool** (`<SYSTEM CALL>`, the tool loop) | `tool-calling.md` |
| **Build a tool** — worked examples of both kinds (script + flow) | `building-tools.md` |
| Understand tool authoring in depth — the why, the return/session contract, when to use each kind | `creating-tools.md` |
| Build a whole flow (worked example, multiple entries) | `example-basic-flow.md` |
| Build the **smallest agent that just answers** | `minimal-agent.md` |
| Know what the **canvas will accept** (field rules, multi-in, sizes) | `field-rules.md` |
| Requests, limits, try/catch, logs, settings + cookies | `best-practices.md` |
| **See what my flow did at runtime — logs & live monitoring** | `observing-your-flow.md` |
| **The traps — silent failures & footguns (read this)** | `gotchas.md` |
| The project files, `keen.json`, `keen-tools.json` | `extension/project-and-files.md` |
| The Shira panel — create / connect / deploy | `extension/the-panel.md` |
| Debug a flow or a script (sandbox only) | `extension/debugging.md` |

## The node catalog (`nodes/`)

All 14 node types, one page each:

| Node | File | | Node | File |
|---|---|---|---|---|
| Start Flow | `nodes/start-flow-node.md` | | Assignment | `nodes/assignment-node.md` |
| End Flow | `nodes/end-flow-node.md` | | Script | `nodes/script-node.md` |
| Condition | `nodes/condition-node.md` | | Agent (LLM) | `nodes/agent-node.md` |
| Loop | `nodes/loop-node.md` | | Parallel Flows | `nodes/parallel-flows-node.md` |
| Run Flow | `nodes/run-flow-node.md` | | Flow Pointer | `nodes/flow-pointer-node.md` |
| Jump Flow | `nodes/jump-flow-node.md` | | Parallel Context | `nodes/parallel-context-node.md` |
| Join Flow | `nodes/join-flow-node.md` | | Note | `nodes/note-node.md` |

## Golden path (build your first flow)

1. Understand the pieces → `business-objects.md`
2. See a minimal agent → `minimal-agent.md`  ·  or a fuller example → `example-basic-flow.md`
3. Learn the nodes you need → `nodes/`
4. Keep the file canvas-valid → `field-rules.md`
5. Set up the project + deploy → `extension/project-and-files.md` + `extension/the-panel.md` (a building
   agent: `keen-validate` → `keen-deploy`, see `agent-runner/docs/DEPLOY.md`)
6. Debug on a sandbox → `extension/debugging.md` · watch the logs → `observing-your-flow.md`
7. Match the agent in the admin → `keen-admin-guide/03-spaces-and-agents.md`

---

## The whole file map

- **Concepts:** `business-objects.md` (what the data is), `flow-lifecycle.md` (a run's life),
  `data-model.md` (the exact technical reference).
- **Nodes:** `nodes/*.md` (14 pages, table above).
- **Tools:** `tool-calling.md` (the `<SYSTEM CALL>` protocol + the tool loop), `building-tools.md` (worked
  examples of a script tool and a flow tool), `creating-tools.md` (the reasoning, the full return/session
  contract, and when to choose each kind).
- **Building:** `example-basic-flow.md`, `minimal-agent.md`, `field-rules.md` (canvas rules),
  `best-practices.md` (requests, limits, try/catch, logs, settings+cookies).
- **The extension:** `extension/project-and-files.md`, `extension/the-panel.md`, `extension/debugging.md`.
- **Traps:** `gotchas.md` (the silent failures & footguns, grouped: tools/agent loop, data/placeholders,
  nodes, scripts, deploy, **channels**).

_Keep this guide current: when a node, menu, field rule, or command changes in Shira or the engines, update
the matching file — and verify the change against the source._
