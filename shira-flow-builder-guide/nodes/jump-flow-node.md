# Jump Flow Node

**Palette name:** `Jump Flow`  ·  **Dots:** **In** (`in`, top) only — **no output dot**  ·
**Settings:** Flow (required), Node Description (optional)

**In one line:** hands control to another flow **and does not come back** — like Run Flow, but it
**finishes in the target** instead of returning.

> Base controls (drag handle, **Settings** sliders toggle, **Rotate**, two-level **Save**, **170px**
> card, **16px** snap) are the same as Start — see `start-flow-node.md`.

---

## What it is / what it's for

A **Jump Flow** node is a **tail call**: it transfers execution into the target flow and **this branch
ends there** — control never returns to the Jump Flow node. It runs in the **same context** as the
caller (shared dictionary + session), exactly like Run Flow; the only difference is the **no return**.

That "no return" is the whole point, and it has two classic uses:

- **A shared final / terminal structure.** If several branches all need to end with the same closing
  logic, factor that into one flow and **jump** to it from each — the branch finishes inside it.
- **Routing / dispatch.** A common shape is **Start → Condition → two Jump Flows**: the condition picks
  a scenario, and each branch **jumps** into the flow that handles it. No branch comes back, so there's
  nothing to wire afterwards.

## Settings

| Field | Required | What it is |
|---|---|---|
| **Flow** | **yes** | The **`File-Label` entry** of the flow to jump into, e.g. `Flow-Start`. Stored in `data.settings.value`. |
| **Description** | no | A plain note; no effect on running. |

### The `Flow` value

Same rules as Run Flow's `Flow`: a **`File-Label`** entry that exists in the deployed project (each half
PascalCase, letters-only, dash-joined), and it **may be cross-file**. The engine interpolates it at
runtime, but the **canvas form only accepts a literal** `File-Label` (its regex rejects `$ { } .`), so use
a **literal** like `Flow-Start` — a dynamic `${…}` target can't be authored on the canvas. A target that
doesn't exist fails with **`E5001`**; a Flow field that resolves to **empty** fails with **`E6101`** (the
engine's message literally reads "Run Flow Node called with empty entry" — the same wording as Run Flow).

## Which dictionary & session it uses

Identical to Run Flow: **dictionary is inherited (shared)** and **session is shared** — the target flow
runs on the caller's stores. The difference is purely control flow (no return), not data scope.

## What a Jump Flow node looks like in the `.flow` file

```json
{
  "nodes": [
    {
      "id": "jumpFlowNode_h8OvUlBWS7i5",
      "type": "jumpFlowNode",
      "position": { "x": 304, "y": 304 },
      "data": {
        "label": "",
        "description": "Continue and finish in different pipe",
        "labelNode": "Jump Flow",
        "descriptionNode": "Execute Flow in this context and continue",
        "open": true,
        "settings": { "value": "Flow-Start" }
      },
      "dragHandle": ".drag-handle__custom"
    }
  ],
  "edges": []
}
```

| Field | Value / rule | What it is |
|---|---|---|
| `id` | `jumpFlowNode_` + **12** `A–Za–z0–9` | id; the `jumpFlowNode_` prefix carries the kind |
| `type` | `"jumpFlowNode"` | mandatory node kind |
| `data.settings.value` | a **`File-Label`** (interpolated) | the flow to jump into |
| `data.labelNode` | **fixed** `"Jump Flow"` | card title |
| `data.descriptionNode` | **fixed** `"Execute Flow in this context and continue"` | card subtitle |
| `data.open` | `true` / `false` | settings panel open state |
| `dragHandle` | `".drag-handle__custom"` | fixed |

### Wiring (edges) — input only

A Jump Flow has **one dot: In** (`in`). It has **no output handle**, so it's the **end of its branch** —
you wire *into* it, never *out* of it:

```json
{
  "id": "xy-edge__<prevId><prevHandle>-jumpFlowNode_h8OvUlBWS7i5in",
  "type": "step",
  "source": "<previousNodeId>",
  "sourceHandle": "<previous out handle>",
  "target": "jumpFlowNode_h8OvUlBWS7i5",
  "targetHandle": "in"
}
```

## Jump Flow vs Run Flow

The **only** difference: **Run Flow returns** (has an **Out** dot, continues after the sub-flow) —
**Jump Flow does not** (no Out dot, finishes in the target). Same `File-Label` field, same interpolation,
same shared dictionary + session. Pick Jump when the branch is done and should end inside the target;
pick Run when you need to keep going here. See `run-flow-node.md`.

## ⚠️ Watch out for

- **There's no Out dot — nothing runs after a Jump.** Anything you *think* comes "after" it won't; put
  that work at the end of the **target** flow instead.
- **`Flow` must be a real `File-Label`** (file + start label, both existing), or the jump fails `E5001`.
- **It shares your dictionary/session** — the target sees everything the caller wrote.

## ⏱ Performance

Light itself; cost is the target flow. Because it doesn't return, there's no continuation bookkeeping on
this side at all.

---

*Next node: Join Flow (`join-flow-node.md`).*
