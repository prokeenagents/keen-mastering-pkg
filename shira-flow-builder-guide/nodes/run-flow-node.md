# Run Flow Node

**Palette name:** `Run Flow`  ·  **Dots:** **In** (`in`, top) · **Out** (`next_1`, bottom)  ·
**Settings:** Flow (required), Node Description (optional)

**In one line:** calls another flow as a **sub-routine** — runs it to completion **in this same context**
(shared dictionary + session), then **returns** and continues out its **Out** dot.

> Base controls (drag handle, **Settings** sliders toggle, **Rotate**, two-level **Save**, **170px**
> card, **16px** snap) are the same as Start — see `start-flow-node.md`. This page covers what's unique.

---

## What it is / what it's for

A **Run Flow** node runs a **sub-flow and comes back**. Point it at a flow's entry (`Flow`), and when
control reaches it the engine runs that whole flow; when the sub-flow finishes, control **returns here**
and leaves through the **Out** dot to whatever comes next.

It's the platform's **function call**. Its main uses (as you'd use a function):

- **Shorten a big flow** — pull a chunk of logic into its own flow and call it.
- **Reuse repeatable logic** — one sub-flow called from many places instead of copy-pasting nodes.
- **Call across files** — the target can live in a **different `.flow` file** (see the `Flow` field).

## Settings

| Field | Required | What it is |
|---|---|---|
| **Flow** | **yes** | The **`File-Label` entry** of the flow to run, e.g. `Project-Start` — file name, a dash, that flow's start-node label. Stored in `data.settings.value`. |
| **Description** | no | A plain note; no effect on running. |

### The `Flow` value — format & the fact that it's dynamic

- It must be a **`File-Label`** entry that exists in the deployed project (see `start-flow-node.md` →
  *The naming rule* — `File` and `Label` are each PascalCase, joined by a dash). `Project-Start` = run
  the start node labelled `Start` in the file `Project.flow`. **Cross-file is normal** — this is exactly
  how you call a flow that lives in another file.
- **The engine interpolates this field at runtime** (`${dictionary.*}` / `${session.*}` resolve), but the
  **canvas form only accepts a literal `File-Label`** — its regex `/^[A-Z][a-zA-Z]*-[A-Z][a-zA-Z]*$/`
  rejects `$ { } .` and digits. So in practice **use a literal** (`Project-Start`); a dynamic
  `${dictionary.whichFlow}` **can't be authored on the canvas** (only hand-edited into the JSON, and it
  gets stripped the next time the node's form is saved). Whatever it resolves to must be a real entry, or
  the run fails with **`E5001` "entry not found"**.

## Which dictionary & session the sub-flow uses (important)

**The sub-flow runs in *this* context — it does not get a fresh, private one.**

- **Dictionary: inherited (shared).** A Run Flow child reads and writes the **same dictionary** as the
  caller (the shared/root dict, keyed by the inherited `currentFlowId`). So anything the sub-flow writes
  is visible here **after it returns** — that's how you get a value back from it. (This is the engine's
  `shared` dict mode — the same one root flows use.)
- **Session: shared.** The whole-run `session` is the same across the caller and the sub-flow (as it is
  for every node in the run).

So a Run Flow is a genuine *inline* call: same scratchpad, same session, control returns. (Contrast a
**Parallel Context** child, which gets a windowed private dict, or a **Parallel Flows** sibling, which
gets an isolated one.)

## What a Run Flow node looks like in the `.flow` file

```json
{
  "nodes": [
    {
      "id": "runFlowNode_qOcolLWDzUgm",
      "type": "runFlowNode",
      "position": { "x": 368, "y": 304 },
      "data": {
        "label": "",
        "description": "Start the pipeline and continue when finish",
        "labelNode": "Run Flow",
        "descriptionNode": "Execute Flow in this context and return",
        "open": true,
        "settings": { "value": "Project-Start" }
      },
      "dragHandle": ".drag-handle__custom"
    }
  ],
  "edges": []
}
```

| Field | Value / rule | What it is |
|---|---|---|
| `id` | `runFlowNode_` + **12** `A–Za–z0–9` | id; the `runFlowNode_` prefix carries the kind |
| `type` | `"runFlowNode"` | mandatory node kind |
| `data.settings.value` | a **`File-Label`** (interpolated) | the sub-flow to run |
| `data.label` | often empty | the card shows the resolved target + description instead |
| `data.labelNode` | **fixed** `"Run Flow"` | card title |
| `data.descriptionNode` | **fixed** `"Execute Flow in this context and return"` | card subtitle |
| `data.open` | `true` / `false` | settings panel open state |
| `dragHandle` | `".drag-handle__custom"` | fixed |

### Wiring (edges)

Two edges: **In** (input) from the previous node, and **Out** (`next_1`) to whatever runs **after** the
sub-flow returns:

```json
{
  "id": "xy-edge__runFlowNode_qOcolLWDzUgmnext_1-<afterId>in",
  "type": "step",
  "source": "runFlowNode_qOcolLWDzUgm",
  "sourceHandle": "next_1",
  "target": "<afterNodeId>",
  "targetHandle": "in"
}
```

## Run Flow vs Jump Flow

Same idea, one crucial difference: **Run Flow returns** (it has an **Out** dot; control comes back and
continues here). **Jump Flow does not** — it transfers into the target and finishes there (no Out dot).
Use Run Flow when you need the result and want to keep going; Jump Flow when this branch is *done* and
should end inside the target. See `jump-flow-node.md`.

## ⚠️ Watch out for

- **`Flow` must be a real `File-Label`.** A typo or a name that isn't in the deployed project fails with
  `E5001`. Cross-file is fine — but the file **and** the start label must both exist.
- **The sub-flow shares your dictionary.** It can overwrite keys you're using — coordinate names, or
  scope with a Parallel Context if you need isolation.
- **Wire the Out dot** if there's work after the call, or the flow stops when the sub-flow returns.

## ⏱ Performance

The node itself is light; cost is whatever the **sub-flow** does. Because it runs inline and returns,
a Run Flow that calls a heavy sub-flow costs exactly what that sub-flow costs.

---

*Next node: Jump Flow (`jump-flow-node.md`).*
