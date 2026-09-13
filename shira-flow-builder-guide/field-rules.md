# Canvas rules — what the builder will accept

An agent generating a `.flow` must produce something the **canvas** accepts, not just something the engine
could run. The settings **forms enforce validation**, and re-saving a node on the canvas re-applies it — so
a value the form would reject can't be authored (and gets stripped if hand-edited then re-saved). This page
is that ruleset: field validation, which handles accept multiple edges, card sizes, and handle positions.

---

## Field validation (per node)

| Node · field | Rule the form enforces |
|---|---|
| **Start** · Label | `/^[A-Z][a-zA-Z]*$/` — capital first, **letters only**, ≤ 60. |
| **Condition** · Condition | **required, ≤ 150** chars (an expression; use `${dictionary.*}`/`${session.*}` — see `nodes/condition-node.md`). The engine itself has no length cap — the 150 is the form's. |
| **Loop** · Read from / Set to | each **required, ≤ 120**; **Read from ≠ Set to**. The form does **not** check the `dictionary.` / `session.` prefix — that is an **engine-time** rule (a bare name saves fine and throws when the loop runs; see `nodes/loop-node.md`). |
| **Assignment / Script** · Key/Value Pairs | **≤ 10 pairs**; key ≤ 100, value ≤ 200; **duplicate keys rejected**. |
| **Script** · Script path | must **end `.js`**, ≤ 160. |
| **Run Flow / Jump Flow / Flow Pointer** · Flow | `/^[A-Z][a-zA-Z]*-[A-Z][a-zA-Z]*$/` — **two capitalized letters-only words joined by a hyphen** (a `File-Label`), ≤ 120. **No digits, no `${}`.** |
| **Parallel Context** · Context Collection | must **start with `dictionary.`**, ≤ 120. · **Flow Pointer (pipe)** = the `File-Label` regex above. · **Assign result** is **required by the form** (min 1, ≤ 80) even though the engine ignores it. |
| **Agent** · Agent ID | `/^[a-z]+(-[a-z]+)*$/` — **kebab-case, letters only** (no digits, no `${}`), 4–60. |
| **Agent** · Agent Name | 4–60 chars (no regex — `${…}` allowed). |
| **Agent** · Session ID / Request ID | no regex, **≤ 60** each — `${…}` allowed; leave blank normally. |
| **Agent** · Prompt turns | content **non-empty**; **≤ 20 turns**; **turn 1 is forced to role `system`**; other turns toggle user↔assistant. Each saved as `{ id, role, content }`. |
| **Note** · Label | the note text, 1–160. |

> **Important nuance on "interpolated" target/id fields.** The engine *does* interpolate the Run/Jump/
> Parallel entry name and the Agent's `agentId` at runtime (`${dictionary.*}`/`${session.*}` resolve) —
> **but the canvas forms above reject `$ { } .`**, so you **cannot author a dynamic value on the canvas**.
> In practice treat these as **literals** (a real `File-Label`, a real slug). A dynamic value would have to
> be hand-edited into the JSON and would be **stripped the next time that node's form is saved**.

## Which `in` handles accept **multiple** incoming edges (multi-in)

Most nodes' `in` takes **one** edge. These accept **many** (you can converge branches on them **without** a
Join):

- **multi-in `in`:** `joinNode`, `parallelInNode`, `endNode`, `runFlowNode`, `jumpFlowNode`, `scriptNode`,
  `loopNode`, `agentNode`. (Plus `parallelInNode`'s **`wait`** handle.)
- **single-in `in`:** `conditionNode`, `assignmentNode`, `parallelContextNode` — and the loop's **`next_2`**
  (Next) is single-in too.

(This is why the basic example can wire two edges into the Agent's `in` — `agentNode.in` is multi-in.)

## Card sizes

Most node cards are a fixed **170px** wide — **except**:
- **Parallel Context** — **200px**.
- **Note** — **500px**.

(Height grows only when a node's Settings panel is open.)

## Handle position (Rotate)

The primary handle sits at a side given by `data.handlePosition`, one of **`top` / `right` / `bottom` /
`left`**. It's **cosmetic** — it changes where the dot renders, never the wiring.

- **Defaults:** **Start** and **Flow Pointer** default to **`bottom`**; every other node defaults to
  **`top`**. The field is normally **absent** in the JSON until you rotate.
- **Rotate order:** each click of the Rotate control advances **Bottom → Left → Top → Right → Bottom**.
- **Join** and **Note** have no meaningful rotate (Join = rotate only; Note has no handles at all).

---

## The universal node & edge shape (recap)

- **Node:** `{ id: "<type>_<12 A-Za-z0-9>", type, position:{x,y}, data:{ label, description, labelNode,
  descriptionNode, open?, settings, handlePosition? }, dragHandle: ".drag-handle__custom" }`. `labelNode` /
  `descriptionNode` are the node kind's fixed titles (see each node page).
- **Edge:** `{ id: "xy-edge__<source><sourceHandle>-<target><targetHandle>", type: "step", source,
  sourceHandle, target, targetHandle }` — those fields only.
- Positions snap to a **16px** grid; keep `x`/`y` multiples of 16.
- Top level of the file is exactly `{ "nodes": [...], "edges": [...] }`.

*See each `nodes/*.md` for a node's exact settings + handle ids.*
