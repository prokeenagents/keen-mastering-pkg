# Parallel Flows Node

**Palette name:** `Parallel Flows` (type `parallelInNode`)  ·  **Dots:** **In** (`in`) · **Wait** (`wait`,
multi-in) · **Out** (`next_1`)  ·  **Settings:** "Condition" (= node label), Assign results to dictionary
property, Description

**In one line:** launches **several whole flows in parallel**, each with its **own private empty
context**, waits for **all** of them, then continues out **Out**. Pairs with **Flow Pointer** nodes.

> Base controls (drag handle, **Settings** toggle, **Rotate**, two-level **Save**, **170px** card,
> **16px** snap) are as on Start — see `start-flow-node.md`. Dictionary "modes" are in `../data-model.md`.

---

## What it is / what it's for (and how it pairs with Flow Pointer)

**Parallel Flows** is a **fan-out + barrier**: it runs a fixed set of flows **at the same time** and only
continues once they've **all** finished. Unlike **Parallel Context** (same flow × N data elements), this
runs **N different flows** you name explicitly.

You declare *which* flows by wiring **Flow Pointer** nodes into the **Wait** handle (see
`flow-pointer-node.md`):

- Each **Flow Pointer** holds a `File-Label` (e.g. `Project-Start`) and its **`out`** dot wires into this
  node's **`wait`** dot.
- Parallel Flows reads its connected wait-nodes, spawns each pointed flow as a **sibling**, and continues
  out **Out** only after every sibling completes.

So the number of parallel flows = the number of Flow Pointers wired into **Wait** (known at build time).

## The three dots

| Dot (label) | Handle id | Direction | Wire it to… |
|---|---|---|---|
| **In** (top) | `in` | input | the previous node |
| **Wait** (side) | `wait` | input (**multi-in**) | the **`out`** of each **Flow Pointer** you want to run |
| **Out** (bottom) | `next_1` | output | what runs **after all** parallel flows finish |

## It waits for all, then continues

Parallel Flows fans out **and** emits its **Out** continuation, but **Out does not run until every
sibling flow has finished** — so downstream of **Out** you're guaranteed all parallel work is done.
(This waiting is the **client SDK's** contract, not something the engine enforces: the engine emits the
sibling flows and the Out continuation together, and the reference clients hold Out until every sibling
has drained — see `../gotchas.md` A13.)

## What dictionary each parallel flow gets (isolated & empty)

This is the **isolated** dictionary mode (see `../data-model.md`) — different from Run Flow (shared) and
Parallel Context (seeded clone):

- **Each sibling gets its OWN private dictionary, started EMPTY.** It is **not** seeded, and it is **not**
  the parent's dictionary — siblings can't see the parent's dict or each other's.
- **Nothing merges back.** When a sibling ends, its dict is **discarded**. (The engine comment is
  literally: *"independent; results travel via channels / return"*.)
- **The session is shared** (all siblings + parent share the whole-run `session`).

So a parallel flow is a clean, independent run. To get data **into** it, the flow must fetch it from the
shared **session** or from **agent-state channels**; to get data **out**, it writes to a **channel** (via
an agent/script node) that the parent reads after **Out** — **not** to a dictionary property.

## ⚠️ Two fields that don't do what their labels suggest

- **"Assign results to dictionary property"** (stored as `settings.value`, `"result"` in the example) —
  **the engine does not read it.** `parallelInNode`'s own `settings.value` is consumed by **no** logic
  (`parallel-in.ts` reads the *wait nodes'* values, not its own; sibling dicts are discarded). So results
  are **not** collected into `dictionary.result`. Collect results via **channels** instead. (Same
  situation as Parallel Context's `assignTo`.)
- **"Condition"** — despite the label, this field is just the **node's display name** (`data.label`,
  `"Await"` in the example; the form's placeholder is literally "Node label"). There is **no condition
  gate** on Parallel Flows — it always spawns every wired Flow Pointer.

## What a Parallel Flows node looks like in the `.flow` file

```json
{
  "id": "parallelInNode_rudfjkXq0izi",
  "type": "parallelInNode",
  "position": { "x": 0, "y": 480 },
  "data": {
    "label": "Await",
    "description": "Await the flows in the wait line",
    "labelNode": "Parallel Flows",
    "descriptionNode": "Execute many flows in parallel with private context",
    "open": false,
    "settings": { "value": "result" }
  },
  "dragHandle": ".drag-handle__custom"
}
```

| Field | Value / rule | What it is |
|---|---|---|
| `id` | `parallelInNode_` + **12** `A–Za–z0–9` | id; prefix carries the kind |
| `type` | `"parallelInNode"` | mandatory node kind |
| `data.label` | the **"Condition"** field | the node's display name — **not** a condition |
| `data.settings.value` | the "Assign results" field | **ignored by the engine** (no-op) |
| `data.labelNode` | **fixed** `"Parallel Flows"` | card title |
| `data.descriptionNode` | **fixed** `"Execute many flows in parallel with private context"` | card subtitle |
| `dragHandle` | `".drag-handle__custom"` | fixed |

### Wiring — Flow Pointers into `wait`

Each Flow Pointer's `out` (`next`) edge lands on this node's `wait` (multi-in). The **`wait` handle accepts
`parallelFlowNode` (Flow Pointer) sources only** — the canvas rejects an edge into `wait` from any other
node. From the real example:

```json
{
  "type": "step",
  "source": "parallelFlowNode_trGPzZ9cn6dA", "sourceHandle": "next",
  "target": "parallelInNode_rudfjkXq0izi", "targetHandle": "wait",
  "id": "xy-edge__parallelFlowNode_trGPzZ9cn6dAnext-parallelInNode_rudfjkXq0iziwait"
}
```

Two such edges (one per Flow Pointer) = two parallel flows. Then wire **In** from upstream and **Out**
(`next_1`) to what follows the barrier.

## ⚠️ Watch out for

- **Results don't land in a dictionary** — the "Assign results" field is a no-op; use channels.
- **"Condition" is just a name** — it doesn't gate anything.
- **Siblings start empty & isolated** — pass inputs via the shared session/channels, not the dictionary.
- **Wire Flow Pointers into `wait`** — an empty wait line means nothing runs in parallel.

## ⏱ Performance

Concurrent fan-out — wall-clock ≈ the slowest sibling. Each sibling costs its whole flow, and they run
at once, so N heavy flows use N× resources in parallel.

---

*Next node: Flow Pointer (`flow-pointer-node.md`).*
