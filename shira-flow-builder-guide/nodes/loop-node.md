# Loop Node

**Palette name:** `Loop`  ·  **Dots:** **In** (`in`, top) · **Out** (`out`, bottom) · **Next** (`next_2`,
left) · **Finish** (`next_1`, right)  ·  **Settings:** Read from (required), Set to (required), Node
Description (optional)

**In one line:** iterates over an array held in the **current dictionary** — for each element it runs a
body once, then continues past the loop when the array is exhausted.

> Base controls (drag handle, the **Settings** sliders toggle, **Rotate**, the two-level **Save**, the
> fixed **170px** card, the **16px** snap grid) are identical to the Start node — see `start-flow-node.md`.
> This page covers what's unique: the four dots and the two field semantics.

---

## What it is / what it's for

A **Loop** node walks an **array**. You point it at a dictionary property that holds a list (`Read from`),
and for **each element** it:

1. writes that element into another dictionary property (`Set to`),
2. sends control out the **Out** dot to run the loop **body**,
3. waits for the body to come back into the **Next** dot, then moves to the next element.

When the array is exhausted, it leaves through the **Finish** dot. It's the platform's `for…of`.

## The four dots (this is the part people misread)

The labels and the handle ids don't line up one-to-one, so read this carefully:

| Dot (label) | Handle id | Direction | Wire it to… |
|---|---|---|---|
| **In** (top) | `in` | input | the previous node's output |
| **Out** (bottom) | `out` | output | the **first node of the loop body** (runs once per element) |
| **Next** (left) | `next_2` | input | the **last node of the loop body** loops back **into here** to request the next element |
| **Finish** (right) | `next_1` | output | what runs **after** the loop finishes (array exhausted) |

So the body is a **cycle**: `Out → …body… → Next → Out → …` until the last element, then **Finish**.
Leaving **Next** unwired means the body runs once and never asks for the next element; leaving **Out**
unwired means the loop has no body.

## Settings

| Field | Required | What it is |
|---|---|---|
| **Read from** | **yes** | A **reference** to the store slot holding the **array** to iterate — `data.settings.value`. Must be **`dictionary.<path>`** or **`session.<key>`** (see the ⚠️ below). It must resolve to an array like `[1,2,3,4,5]` — so in practice a **`dictionary.`** path: a session value can never be an array, and a `session.` source goes straight to **Finish**. |
| **Set to** | **yes** | A **reference** to the slot that receives the **current element** on each pass — `data.settings.setto`. Same `dictionary.<path>` / `session.<key>` rule (a `session.` target only for **primitive** elements — an object or array element is rejected). Iteration 1 writes element `[0]`, iteration 2 writes `[1]`, … The body reads the current element from here. |
| **Description** | no | A plain note; no effect on running. |

> ⚠️ **`Read from` and `Set to` are path *references*, and they MUST carry the root prefix**
> `dictionary.` or `session.` (an optional `${…}` wrapper is allowed — `${dictionary.fromProp}` works
> too). A **bare** `fromProp` / `result` (which the canvas form accepts unvalidated) does **not** run: the
> engine's `parsePath` returns nothing and `loopNode` **throws** *"LoopNode: invalid 'value' — expected
> dictionary.<path> or session.<key>"*, and `keen-validate` rejects it. Write the prefixed form, as the
> example below does: `value: "dictionary.fromProp"`, `setto: "dictionary.result"`. `dictionary.*` may be
> a **nested** dot-path; `session.*` is a **flat** key. These are references (which slot), **not**
> `${...}` value-interpolation and not identifiers with a naming rule.

## What a Loop node looks like in the `.flow` file

```json
{
  "nodes": [
    {
      "id": "loopNode_Gr7Slq2XoUg3",
      "type": "loopNode",
      "position": { "x": 432, "y": 288 },
      "data": {
        "label": "",
        "labelNode": "Loop",
        "descriptionNode": "Loop dictionary iterable segment",
        "open": true,
        "settings": { "value": "dictionary.fromProp", "setto": "dictionary.result" },
        "description": "test"
      },
      "dragHandle": ".drag-handle__custom"
    }
  ],
  "edges": []
}
```

| Field | Value / rule | What it is |
|---|---|---|
| `id` | `loopNode_` + **12** `A–Za–z0–9` | id; the `loopNode_` prefix carries the kind |
| `type` | `"loopNode"` | mandatory node kind |
| `data.settings.value` | `dictionary.<path>` reference | **Read from** — the array to iterate |
| `data.settings.setto` | `dictionary.<path>` (or `session.<key>`) reference | **Set to** — where each element lands |
| `data.label` | often empty | the loop has no natural one-line label; the card shows the description |
| `data.labelNode` | **fixed** `"Loop"` | card title |
| `data.descriptionNode` | **fixed** `"Loop dictionary iterable segment"` | card subtitle |
| `data.open` | `true` / `false` | settings panel open state |
| `dragHandle` | `".drag-handle__custom"` | fixed |

### Wiring the four dots (edges)

Four edges are typical: **In** (input), **Out**→body, body→**Next** (input), **Finish**→after. Example
Out edge:

```json
{
  "id": "xy-edge__loopNode_Gr7Slq2XoUg3out-<bodyFirstId>in",
  "type": "step",
  "source": "loopNode_Gr7Slq2XoUg3",
  "sourceHandle": "out",
  "target": "<bodyFirstNodeId>",
  "targetHandle": "in"
}
```

The body's last node wires **back into** the loop with `"target": "loopNode_…"`, `"targetHandle": "next_2"`
(the **Next** input). **Finish** is a normal forward edge with `"sourceHandle": "next_1"`.

## How the iteration runs (verified in `node-logic/nodes/loop.ts`)

The loop is a little state machine that keeps its progress **inside the dictionary** under a reserved key
`dictionary['__loops'][<thisNodeId>] = { snapshot, index }`:

1. **First time the node runs** (no state yet): it reads the array from `Read from`. If that value is
   **not a non-empty array**, *or* nothing is wired to **Out** (no body), it goes straight to **Finish**.
   Otherwise it takes a **deep-copy snapshot** of the array, writes element `[0]` into `Set to`, saves
   `{ snapshot, index: 0 }`, and goes out **Out** to run the body.
2. **Each time the body loops back into Next** (state exists): the loop node runs again, **advances the
   index**. If the index is past the end → it **clears its state** and goes **Finish**. Otherwise it
   writes element `[index]` into `Set to` and goes out **Out** again.

Key consequences for an author:

- The current element is delivered through **`Set to`** — the body reads it from there (e.g.
  `${dictionary.result}` in a downstream field).
- The array is **snapshotted once** at loop start (deep copy). Mutating the source array *during* the
  loop does **not** change what it iterates.
- `__loops` is a **reserved** dictionary key the loop manages — don't read or write it yourself.
- The dictionary is committed every pass (it holds the loop state + the `Set to` write). If `Set to`
  targets `session.<key>`, the session is committed too.
- Scope: the loop reads/writes the **current flow's** dictionary (and the shared run session for a
  `session.` target) — the same stores every other node in this flow sees.

## ⚠️ Watch out for

- **Wire `Next` back to the loop**, or the body runs once and the loop never advances.
- **`Read from` must hold an array** — point it at a dictionary property that actually contains a list
  (never `session.` — session values are primitives).
- **Out / Next are a cycle, Finish is the exit** — don't wire the body straight into Finish.

## ⏱ Performance

The loop itself is light bookkeeping; cost is whatever the **body** does × the number of elements. A
large array means the body runs many times — size it with that in mind.

---

*Next node: Run Flow (`run-flow-node.md`).*
