# Canvas rules — what the builder will accept

An agent generating a `.flow` must produce something the **canvas** accepts, not just something the engine
could run. The settings **forms enforce validation**, and re-saving a node on the canvas re-applies it — so
a value the form would reject can't be authored (and gets stripped if hand-edited then re-saved). This page
is that ruleset: field validation, the handle ids an edge uses, which handles accept multiple edges, card
sizes, and handle positions. `keen-validate` checks the same rules before a deploy.

---

## Field validation (per node)

| Node · field | Rule the form enforces |
|---|---|
| **Start** · Label | `/^[A-Z][a-zA-Z]*$/` — capital first, **letters only**, ≤ 60. |
| **Condition** · Condition | **required, ≤ 150** chars (an expression; use `${dictionary.*}`/`${session.*}` — see `nodes/condition-node.md`). The engine itself has no length cap — the 150 is the form's. |
| **Loop** · Read from / Set to | each **required, ≤ 120**; **Read from ≠ Set to**. The form does **not** check the `dictionary.` / `session.` prefix — that is an **engine-time** rule (a bare name saves fine on the canvas and throws when the loop runs; `keen-validate` rejects it — see `nodes/loop-node.md`). |
| **Assignment / Script** · Key/Value Pairs | **≤ 10 pairs**; key ≤ 100, value ≤ 200; **duplicate keys rejected**. |
| **Script** · Script path | must **end `.js`**, ≤ 160. |
| **Run Flow / Jump Flow / Flow Pointer** · Flow | `/^[A-Z][a-zA-Z]*-[A-Z][a-zA-Z]*$/` — **two capitalized letters-only words joined by a hyphen** (a `File-Label`), ≤ 120. **No digits, no `${}`.** |
| **Parallel Context** · Context Collection | must **start with `dictionary.`**, ≤ 120. · **Flow Pointer (pipe)** = the `File-Label` regex above. · **Assign result** is **required by the form** (min 1, ≤ 80) even though the engine ignores it. |
| **Agent** · Agent ID | `/^[a-z]+(-[a-z]+)*$/` — **kebab-case, letters only** (no digits, no `${}`), 4–60. |
| **Agent** · Agent Name | 4–60 chars (no regex — `${…}` allowed). |
| **Agent** · Session ID / Request ID | no regex, **≤ 60** each — `${…}` allowed; leave blank normally. |
| **Agent** · Prompt turns | content **non-empty**; **≤ 20 turns**; **turn 1 is forced to role `system`**; other turns toggle user↔assistant. Each saved as `{ id, role, content }` — the form mints a UUID `id` for a turn that has none (the engine tolerates a missing `id`, but write one so the file matches what the canvas saves). |
| **Note** · Label | the note text, 1–160. |

> **Important nuance on "interpolated" target/id fields.** The engine *does* interpolate the Run / Jump /
> Flow Pointer target and the Agent's `agentId` at runtime (`${dictionary.*}`/`${session.*}` resolve; a
> Parallel Context pipe is **not** interpolated) — **but the canvas forms above reject `$ { } .`**, and
> `keen-validate` enforces the same rules as errors. In practice treat these as **literals** (a real
> `File-Label`, a real slug). A dynamic value written into the JSON fails validation and is **stripped the
> next time that node's form is saved**.

> **Digits in a flow file name.** The file name (and the agent's Start Flow) may contain digits
> (`/^[A-Z][A-Za-z0-9]*$/`), but a `File-Label` target is letters only, so a node or a flow tool can never
> target `Report2.flow`. Name flow files **letters-only PascalCase**; `keen-validate` warns on a digit.

## Handle ids — what goes in an edge's `sourceHandle` / `targetHandle`

Write the **canvas** handle id of each dot. The deploy compiler renames four of them onto the engine's
routing keys; everything else passes through unchanged:

| Node | Out (`sourceHandle`) | In (`targetHandle`) | Compiler renames |
|---|---|---|---|
| Start | `next` | — | `next` → `next_1` |
| Flow Pointer | `next` (into a Parallel Flows `wait`) | — | `next` → `next_1` |
| Condition | `true`, `false` | `in` | `true` → `next_1`, `false` → `next_2` |
| Loop | `out` (body), `next_1` (Finish) | `in`, `next_2` (Next — the body's return) | `out` → `next_2` |
| Agent (LLM) / Script | `next_1`, `error` | `in` | — |
| Assignment / Run Flow / Join / Parallel Context | `next_1` | `in` | — |
| Parallel Flows | `next_1` | `in`, `wait` | — |
| End / Jump Flow | — | `in` | — |
| Note | — | — | — |

So `next_1` **is** a canvas id for most nodes — write it. What you must not do is write the engine key
in place of one of the four renamed ids (`next_1` on a Start, `next_1` / `next_2` on a Condition, `next_2`
for a Loop body): `keen-validate` rejects a handle that isn't in the node's canvas set.

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
