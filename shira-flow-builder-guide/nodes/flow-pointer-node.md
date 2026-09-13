# Flow Pointer Node

**Palette name:** `Flow Pointer` (type `parallelFlowNode`)  ·  **Dots:** **out** (`next`) only — no input
 ·  **Settings:** Flow (required), Description

**In one line:** a **declaration**, not a step — it **names one flow** to run, and you wire it into a
**Parallel Flows** node's **Wait** line. It never executes on its own.

> Base controls (drag handle, **Settings** toggle, **Rotate**, two-level **Save**, **170px** card,
> **16px** snap) are as on Start — see `start-flow-node.md`.

---

## What it is / what it's for

A **Flow Pointer** exists **only** to feed a **Parallel Flows** node. It holds a single `File-Label`
(the flow to run) and has one **`out`** dot — you drag that into the Parallel Flows **`wait`** dot. When
the Parallel Flows node runs, it reads each connected Flow Pointer's target and spawns that flow in
parallel.

It is **not** on the execution path itself: it has **no input dot**, and the engine never "runs" a Flow
Pointer — it's a data-holder the Parallel Flows node reads. Think of it as one entry in a list of
"flows to await".

## Settings

| Field | Required | What it is |
|---|---|---|
| **Flow** | **yes** | `data.settings.value` — the **`File-Label`** of the flow this pointer names (e.g. `Project-Start`). |
| **Description** | no | A plain note; no effect on running. |

### The `Flow` value — and yes, it's interpolated

- It must be a **`File-Label`** entry (file + start label, each PascalCase, dash-joined) that exists in
  the deployed project — cross-file is fine.
- **The engine interpolates it at runtime**, but the **canvas form only accepts a literal `File-Label`**
  (its regex `/^[A-Z][a-zA-Z]*-[A-Z][a-zA-Z]*$/` rejects `$ { } .` and digits) — so **use a literal** like
  `Project-Start`; a dynamic `${dictionary.whichFlow}` can't be authored on the canvas (only hand-edited
  into JSON, and stripped on re-save). An entry that doesn't resolve to a real flow is **silently
  skipped** — that parallel branch just doesn't run.

## What flow it starts — and with what dictionary

The flow a Flow Pointer names is launched by **Parallel Flows** as a **sibling**, so it starts with an
**own private, EMPTY dictionary** (isolated), shares the whole-run **session**, and its dict is
**discarded** at the end (nothing merges back). See `parallel-flows-node.md` and `../data-model.md` for
the full picture.

## What a Flow Pointer looks like in the `.flow` file

```json
{
  "id": "parallelFlowNode_trGPzZ9cn6dA",
  "type": "parallelFlowNode",
  "position": { "x": 272, "y": 304 },
  "data": {
    "label": "Project-Start",
    "description": "Flow",
    "labelNode": "Flow Pointer",
    "descriptionNode": "Point to the flow that must be awaited",
    "open": false,
    "settings": { "value": "Project-Start", "label": "Project-Start" }
  },
  "dragHandle": ".drag-handle__custom"
}
```

| Field | Value / rule | What it is |
|---|---|---|
| `id` | `parallelFlowNode_` + **12** `A–Za–z0–9` | id; prefix carries the kind |
| `type` | `"parallelFlowNode"` | mandatory node kind |
| `data.settings.value` / `.label` | a **`File-Label`** (interpolated) | the flow this pointer names |
| `data.labelNode` | **fixed** `"Flow Pointer"` | card title |
| `data.descriptionNode` | **fixed** `"Point to the flow that must be awaited"` | card subtitle |
| `data.handlePosition` | optional (e.g. `"top"`) | which side the `out` dot renders (cosmetic) |
| `dragHandle` | `".drag-handle__custom"` | fixed |

### Wiring — `out` into a Parallel Flows `wait`

A Flow Pointer has **only** an `out` handle (`next`). Wire it into a **Parallel Flows** node's `wait`
(multi-in):

```json
{
  "type": "step",
  "source": "parallelFlowNode_trGPzZ9cn6dA", "sourceHandle": "next",
  "target": "parallelInNode_rudfjkXq0izi", "targetHandle": "wait",
  "id": "xy-edge__parallelFlowNode_trGPzZ9cn6dAnext-parallelInNode_rudfjkXq0iziwait"
}
```

## ⚠️ Watch out for

- **Only useful with Parallel Flows.** A Flow Pointer wired to anything but a `wait` handle does nothing
  — it's not a runnable step.
- **No input dot** — nothing flows *into* a Flow Pointer; it's a leaf declaration.
- **`Flow` must resolve to a real `File-Label`**, or that parallel branch is silently skipped.

## ⏱ Performance

None of its own — it's a declaration the Parallel Flows node reads. The cost is in the flow it names.

---

*Next node: End Flow (`end-flow-node.md`).*
