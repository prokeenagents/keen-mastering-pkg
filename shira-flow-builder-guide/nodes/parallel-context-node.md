# Parallel Context Node

**Palette name:** `Parallel Context`  ·  **Dots:** **In** (`in`) · **Out** (`next_1`)  ·  **Settings:**
Flow Pointer (required), Context Collection (required), Assign result to dictionary property, Description

**In one line:** **map-reduce** — runs **one template flow once per element** of a dictionary array,
**concurrently**, each run on its own copy of that element; when **all** runs finish it merges each
result back and continues.

> Base controls (drag handle, **Settings** toggle, **Rotate**, two-level **Save**, **16px** snap) are as
> on the Start node — see `start-flow-node.md`. (This card is **200px** wide, not the usual 170px.)

---

## What it is / what it's for

A **Parallel Context** node takes an **array in the dictionary** and runs the **same flow** over every
element **at the same time** — like `Promise.all(collection.map(runFlow))`. Use it to process N items in
parallel: generate N variations, score N candidates, call a sub-pipeline for each of N inputs.

The lifecycle:

1. Read the array at **Context Collection** (`dictionary.<path>`).
2. For **each element**, spawn a run of the **Flow Pointer** template flow — **concurrently**.
3. Each run starts with its **own private dictionary seeded from that one element**.
4. **Wait for every run to finish**, merge each result back (see below), then continue out **Out**.

## It waits for all iterations, then continues

The node fans out **and** emits its **Out** continuation, but the **Out** branch does **not** run until
**every** context run has completed. So anything wired after **Out** is guaranteed to see **all** results
already merged in — you can safely read the finished collection there. (This waiting is the **client
SDK's** contract, not something the engine enforces: the engine emits the fan-out and the Out
continuation together, and the reference clients hold Out until every run has drained — see
`../gotchas.md` A13.)

## Settings

| Field | Required | What it is |
|---|---|---|
| **Flow Pointer** | **yes** | `data.settings.pipe` — the **`File-Label`** of the template flow to run once per element (e.g. `Project-Start`). **Static** — *not* interpolated. |
| **Context Collection** | **yes** | `data.settings.contextCollection` — a reference **`dictionary.<path>`** to the **array** to map over (the form requires the literal `dictionary.` prefix, ≤ 120 chars; the engine would also accept a `${dictionary.<path>}` wrapper). Must resolve to an array; each element should be a **plain object** (non-objects are replaced with `{}`). |
| **Assign result to dictionary property** | **required by the form** | `data.settings.assignTo` — the form makes you fill it (min 1, ≤ 80 chars), but **the engine ignores it** (see the ⚠️ below). |
| **Description** | no | A plain note; no effect on running. |

### ⚠️ `Assign result to dictionary property` (`assignTo`) — verified: it's a **no-op**

The form offers "Assign result to dictionary property", but **the engine does not read `assignTo`**.
It is declared in the node type (`@types/node.d.ts`) yet **referenced by no logic anywhere in the
engine** — the results are **not** written to `dictionary.<assignTo>`.

**Where the results actually go:** when each context run finishes, its **entire final dictionary** is
**merged back into its own element of the collection** — `dictionary.contexts[i]` is **overwritten** with
what run *i* produced (`taskMgr.mergeContextClone`). So **read the results from the Context Collection
itself** after **Out**:

```text
before:  dictionary.contexts = [ {x:1}, {x:2}, {x:3}, {x:4} ]
each run: starts with dictionary = {x:N}, runs Project-Start, ends with (say) {x:N, y:N*10}
after:   dictionary.contexts = [ {x:1,y:10}, {x:2,y:20}, {x:3,y:30}, {x:4,y:40} ]
```

So the "assign to" you want is effectively **the collection**. (If a single aggregate property is what
you need, that would require wiring `assignTo` in the engine — as of now it does nothing.)

## The dictionary each run gets (isolated? shared? — this is the key)

Parallel Context uses the **clone** dictionary mode (see `../data-model.md`), which is different from
both Run Flow (shared) and Parallel Flows (empty-isolated):

- **Private, per element.** Each run gets its **own** working dictionary — siblings never share a key,
  so they can't clobber each other.
- **Seeded from the element.** That private dict **starts as a deep copy of `collection[i]`**. If element
  `[1]` is `{x:2}`, the run begins with `dictionary` equal to `{x:2}` — the flow reads its input straight
  from `dictionary`.
- **Merged back per-element.** When the run ends, its **whole final dict** is written back to
  `collection[i]` (path-scoped, so concurrent merges to different indices don't collide).
- **Session is still shared** — the whole-run `session` is common to all the parallel runs (only the
  dictionary is windowed).

So inside the template flow (`Project-Start`), treat `dictionary` as "my one element" — read the input
from it, write your output onto it; whatever it holds at the end becomes that element's result.

## What a Parallel Context node looks like in the `.flow` file

```json
{
  "nodes": [
    {
      "id": "parallelContextNode_XyimzAw2xvxY",
      "type": "parallelContextNode",
      "position": { "x": 16, "y": 336 },
      "data": {
        "label": "",
        "description": "Execute same pipeline many times as per Context Collection length",
        "labelNode": "Parallel Context",
        "descriptionNode": "Point to the single flow that must be awaited with predefined context",
        "open": true,
        "settings": {
          "assignTo": "result",
          "contextCollection": "dictionary.contexts",
          "pipe": "Project-Start"
        }
      },
      "dragHandle": ".drag-handle__custom"
    }
  ],
  "edges": []
}
```

| Field | Value / rule | What it is |
|---|---|---|
| `id` | `parallelContextNode_` + **12** `A–Za–z0–9` | id; prefix carries the kind |
| `type` | `"parallelContextNode"` | mandatory node kind |
| `data.settings.pipe` | a **`File-Label`** (static) | the template flow run per element |
| `data.settings.contextCollection` | **`dictionary.<path>`** | the array to map over |
| `data.settings.assignTo` | (ignored) | **not read by the engine** — see above |
| `data.labelNode` | **fixed** `"Parallel Context"` | card title |
| `data.descriptionNode` | **fixed** `"Point to the single flow that must be awaited with predefined context"` | card subtitle |
| `dragHandle` | `".drag-handle__custom"` | fixed |

### Wiring (edges)

**In** from the previous node, **Out** (`next_1`) to what runs **after all runs finish**. Edges carry
`"type": "step"` plus `{ id, source, sourceHandle, target, targetHandle }`.

## ⚠️ Watch out for

- **`assignTo` does nothing** — read results from the **Context Collection** (`dictionary.contexts`),
  each element replaced by its run's output. Don't expect `dictionary.result`.
- **Context Collection must be `dictionary.<path>` to an array** — no `session`, no bare name; empty /
  non-array ⇒ no fan-out (it just continues).
- **Elements should be plain objects** — non-object elements are replaced with `{}` before the run, so
  a run over `[1,2,3]` sees `{}` inputs. Wrap scalars: `[{v:1},{v:2},…]`.
- **Flow Pointer is static** — it is not interpolated, so it must be a literal `File-Label`.
- **Out waits for all** — heavy per-element work × N runs concurrently; size the collection accordingly.

## ⏱ Performance

The fan-out is concurrent, so wall-clock ≈ the **slowest single run**, not the sum — but every run costs
what the template flow costs, and they run at once, so N large runs use N× the resources in parallel.

---

*Next node: End Flow (`end-flow-node.md`).*
