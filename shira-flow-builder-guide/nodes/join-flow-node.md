# Join Flow Node

**Palette name:** `Join Flow`  ·  **Dots:** **In** (`in`, multi-in) · **Out** (`next_1`)  ·
**Settings:** **none** (no configuration)  ·  **Controls:** drag handle + **Rotate** only (no Settings
toggle)

**In one line:** a **merge point** — many branches wire into its one **In** dot and continue out a
single **Out**, so several paths share one downstream instead of each re-wiring to it.

> Base controls (drag handle, **Rotate**, two-level **Save**, **170px** card, **16px** snap) are as on
> the Start node — see `start-flow-node.md`. Unlike Start, Join has **no Settings toggle and no settings
> form** at all.

---

## What it is / what it's for

A **Join Flow** node is a **common merge point**. Its `In` dot accepts **many** incoming edges; whatever
reaches it continues out the single `Out` dot. You use it for:

- **Tidiness / precision** — instead of wiring three branches each into the same downstream node, wire
  all three into one Join, then Join → the downstream once. The graph reads cleanly.
- **A shared continuation** — when several paths should all end up doing the same next thing, converge
  them on a Join and put that shared continuation after it once.

## It is a pass-through, **not a barrier** (important)

A Join does **not wait** for all its incoming branches. It's a **pure pass-through**: verified in the
engine (`joinNode` → `runPassthrough`, `node-logic/nodes/passthrough.ts`) it simply emits `next_1` and
stores nothing. So **each path that arrives continues out immediately** — if two live paths reach the
same Join, the downstream runs **twice** (once per arrival), it is not run once "after both".

- Join = *"these arrows all point at the same next step"* (graph convenience).
- If you need *"wait until N parallel branches all finish, then continue once"* — that's a **barrier**,
  and the node for it is **Parallel Flows** (`parallelInNode`) with its **Wait** handle, **not** Join.
  (See `parallel-flows-node.md`.)

> In a typical agent flow only **one** entry runs, so usually only one path flows through a Join — the
> multiple `In` connections are branches you *might* take, converging on one continuation.

## On the canvas

An **orange merge (∨) icon** card titled **Join Flow**, subtitle **"Common merge point"**, with an **In**
dot on top and an **Out** dot at the bottom. Its only control is **Rotate** (there's no Settings toggle,
because there's nothing to configure). It has an optional card label only if a `settings.value` happens
to be present, but the UI provides no way to set one — treat Join as **configuration-free**.

## Settings

**None.** Join has no settings form — no Label, no Description, no expression. It's purely structural.

## What a Join node looks like in the `.flow` file

Its `data` is minimal — **no `settings`, no `open`**. Here's the real merge example from the screenshot
(two Start nodes → one Join → a Jump), which also shows the **edge** shape:

```json
{
  "nodes": [
    {
      "id": "joinNode_qhkiuQBPh7El",
      "type": "joinNode",
      "position": { "x": 336, "y": 352 },
      "data": { "label": "", "labelNode": "Join Flow", "descriptionNode": "Common merge point" },
      "dragHandle": ".drag-handle__custom"
    }
  ],
  "edges": [
    {
      "type": "step",
      "source": "startNode_U7FdrLmy6G8C", "sourceHandle": "next",
      "target": "joinNode_qhkiuQBPh7El", "targetHandle": "in",
      "id": "xy-edge__startNode_U7FdrLmy6G8Cnext-joinNode_qhkiuQBPh7Elin"
    },
    {
      "type": "step",
      "source": "startNode_TjS9rgu4jw5n", "sourceHandle": "next",
      "target": "joinNode_qhkiuQBPh7El", "targetHandle": "in",
      "id": "xy-edge__startNode_TjS9rgu4jw5nnext-joinNode_qhkiuQBPh7Elin"
    },
    {
      "type": "step",
      "source": "joinNode_qhkiuQBPh7El", "sourceHandle": "next_1",
      "target": "jumpFlowNode_Ca2L0x71RAqc", "targetHandle": "in",
      "id": "xy-edge__joinNode_qhkiuQBPh7Elnext_1-jumpFlowNode_Ca2L0x71RAqcin"
    }
  ]
}
```

| Field | Value / rule | What it is |
|---|---|---|
| `id` | `joinNode_` + **12** `A–Za–z0–9` | id; the `joinNode_` prefix carries the kind |
| `type` | `"joinNode"` | mandatory node kind |
| `data` | `{ label, labelNode, descriptionNode }` | **no `settings`, no `open`** — nothing to configure |
| `data.labelNode` | **fixed** `"Join Flow"` | card title |
| `data.descriptionNode` | **fixed** `"Common merge point"` | card subtitle |
| `dragHandle` | `".drag-handle__custom"` | fixed |

### Multi-in — the defining trait

Join's **`in`** handle is **multi-in** — it accepts **many** incoming edges. (Several nodes' `in` are
multi-in — see `../field-rules.md`; what's special about Join is that merging is its *only* job.) The
example above has **two** edges with `"targetHandle": "in"` landing on the same Join. Wire as many sources
into `in` as you need; there's one `next_1` out.

### The edge shape — note `type: "step"`

As the example shows, saved edges carry **`"type": "step"`** (the orthogonal routing style) plus the five
identity fields `{ id, source, sourceHandle, target, targetHandle }`. Include `"type": "step"` when you
author edges by hand; the `id` is `xy-edge__<source><sourceHandle>-<target><targetHandle>`.

## ⚠️ Watch out for

- **It does not synchronize.** Don't use a Join to "wait for both branches" — it fires per arrival. Use
  **Parallel Flows** + **Wait** for a real barrier.
- **Nothing to configure** — if you're looking for a setting on a Join, there isn't one; it's structural.
- **Wire the Out** (`next_1`) onward, or the merged path ends at the Join.

## ⏱ Performance

Zero of its own — a pure pass-through that emits its successor and stores nothing.

---

*Next node: End Flow (`end-flow-node.md`).*
