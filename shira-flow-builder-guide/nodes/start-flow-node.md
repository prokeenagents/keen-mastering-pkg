# Start Flow Node

**Palette name:** `Start Flow`  ·  **Dots:** one **out** only (no inputs)  ·  **Settings:** Node Label (required), Node Description (optional)

**In one line:** the entry point of a flow — every flow begins at a Start node, and its **label is the
flow's addressable entry name**.

---

## What it is / what it's for

A **Start Flow** node is where a flow begins. Every flow must have one: when the engine runs a flow it
starts here and follows the wiring out of this node. There is nothing "before" a Start node — it has
**no input dot**, only a single **out** dot.

Its real job is naming: the Start node's **label** is how the flow is *addressed*. When an agent runs,
or when one flow calls another, they don't point at a file alone — they point at a **`File-Label`**
entry, and that `Label` is a Start node's label. Get the label right and everything that references
this flow finds it; get it wrong and nothing does.

## On the canvas

1. Open the **Node panel** (the palette) and drag **Start Flow** onto the canvas. It appears as a card
   titled **Start Flow** — a ▶ (play) icon, the subtitle **"Flow entry point"**, and a single **out**
   dot at the bottom. It has **no input dot**.
2. The node card has three controls: the **drag handle** (the ⣿ dots, top-left — grab it to move the
   node), a **Settings** toggle (the sliders icon, top-right — opens/closes the settings panel), and a
   **Rotate** control (the circular-arrows icon — spins the connector to another side, cosmetic, for
   tidy wiring).
3. Open **Settings**, fill the fields (below), and **wire the out dot** to the first node that should
   run after start (drag from the *out* dot to the next node's input dot).

## Settings

Click the Settings toggle to open the panel on the right:

| Field | Required | What it is |
|---|---|---|
| **Label** | **yes** | The flow's **entry gate** — the exact name that says *where the flow begins*. Without it, nothing can tell where to start running the flow. This is the load-bearing field. Form cap **≤ 60** chars; naming rule below. |
| **Description** | no | A plain note — clear visual info on what this node is for. No effect on running. Form cap **≤ 250** chars. |

### Saving your changes (two levels — don't miss the second)

1. In the settings panel, press **Save** — this applies the label/description to the node **on the
   canvas**.
2. Then **save the file** (the usual editor save, e.g. Ctrl/Cmd+S) — this persists the change **into
   the project** on disk.

Press Save but forget to save the file and your change lives only in the open canvas — it isn't in the
project yet, so a deploy won't pick it up.

### The naming rule (strict — the form and the platform enforce it)

- The **Label** must be **one word, starting with a capital letter, letters only** — **no digits**, no
  spaces, no dashes. The Start form validates it with `/^[A-Z][a-zA-Z]*$/`: `Start`, `Next`, `Main`,
  `Boom` pass; `Start2` and `my-start` are rejected. Keep it letters-only so it also lines up with the
  agent's **Start Node** field. Practical cap: **≤ 60 characters** (the agent's Start Node caps there).
- The **flow file** is named the same way and its extension is **`.flow`** (not `.flow.json`) — e.g. a
  flow whose start label is `Main` lives in `Main.flow`.
- The flow is then addressed as **`File-Label`** — file name, a dash, the start label. Example: a file
  `Simo.flow` with a start node labelled `Next` is the entry **`Simo-Next`**.
- **The Label is a static identifier — not a value.** `${dictionary.*}` / `${session.*}` placeholders
  do **not** work here: the regex forbids `$ { } .`, and the deploy compiler reads the label as an
  **entry key** — *before* any dictionary or session exists — and the Start node never reads it at
  runtime (it is a pure pass-through). (A Run / Jump / Flow Pointer target, by contrast, *is* interpolated
  by the engine, but its form and `keen-validate` accept only a literal letters-only `File-Label` — see
  `../field-rules.md`.)
- **Name the flow file letters-only.** The file name may contain digits (`/^[A-Z][A-Za-z0-9]*$/`, the
  same rule as the agent's Start Flow), but every `File-Label` target is letters only — so `Report2.flow`
  can be an agent's start flow, yet no Run / Jump / Flow Pointer / Parallel Context node or flow tool can
  ever target it. `keen-validate` warns on a digit in a flow file name.

## What a Start node looks like in the `.flow` file

On the canvas path the canvas writes this when you Save + save the file. A building agent writes the same
JSON **by hand** — so match this shape exactly. A Start node in a `.flow` document:

```json
{
  "nodes": [
    {
      "id": "startNode_mK8HmeWTUjYN",
      "type": "startNode",
      "position": { "x": 208, "y": 176 },
      "data": {
        "label": "Start",
        "description": "This is a description",
        "labelNode": "Start Flow",
        "descriptionNode": "Flow entry point",
        "open": false,
        "settings": { "value": "Start", "label": "Start" }
      },
      "dragHandle": ".drag-handle__custom"
    }
  ],
  "edges": []
}
```

| Field | Value / rule | What it is |
|---|---|---|
| `id` | `startNode_` + **12** letters/digits | the node's unique id — always this prefix; the canvas generates it, and when you write the file by hand you generate 12 random characters yourself (unique in the file) |
| `type` | `"startNode"` | the node kind — **mandatory**; how the engine knows to run it as a Start |
| `position` | `{ x, y }` | where the card sits on the canvas — standard from the React Flow plugin ([reactflow.dev](https://reactflow.dev/)); cosmetic |
| `data.label` | your **Label** (e.g. `Start`) | the entry name you typed in the settings form |
| `data.description` | your **Description** | the note you typed |
| `data.labelNode` | **fixed** `"Start Flow"` | the **title shown on the card** — always exactly this; the node kind's identity, don't change it |
| `data.descriptionNode` | **fixed** `"Flow entry point"` | the **subtitle shown on the card** — always exactly this; don't change it |
| `data.open` | `true` / `false` | whether the settings form is currently open on the canvas |
| `data.settings` | `{ value, label }` — **mandatory** | carries the label the engine reads; both `value` and `label` hold your Label |
| `dragHandle` | `".drag-handle__custom"` | **fixed** — the grip the canvas uses to drag the card |
| `edges` (file level) | `[]` until you wire the *out* dot | the connections between nodes — standard React Flow; the canvas fills it as you wire |

> The `.flow` file keeps **only** `{ nodes, edges }` at the top level. If you hand-add any other top-level
> key it's dropped the next time the file is edited on the canvas (and `keen-validate` warns about it) —
> so write only what the canvas would save.
>
> The `id`'s 12 characters are `A–Z a–z 0–9`, `crypto`-random; the `<type>_` prefix is **load-bearing**
> — the engine derives the node kind from it (`getNodeType` substring-matches `startNode` in the id).

### Wiring the out dot (the edge)

The Start node has one output — the **out** dot, whose handle id in the file is **`next`** (its visible
label is "out"). Dragging from it to the next node's input writes an **edge** into the top-level
`edges` array:

```json
{
  "id": "xy-edge__startNode_mK8HmeWTUjYNnext-endNode_ab12cd34ef56in",
  "type": "step",
  "source": "startNode_mK8HmeWTUjYN",
  "sourceHandle": "next",
  "target": "endNode_ab12cd34ef56",
  "targetHandle": "in"
}
```

- `source` / `target` = the two node **ids**; `sourceHandle` / `targetHandle` = the **handle ids** on
  each end (`next` out of Start; `in` into most nodes).
- `id` is generated as `xy-edge__<source><sourceHandle>-<target><targetHandle>` (concatenated, no
  separators).
- Saved edges carry **`"type": "step"`** (the orthogonal routing) plus those five identity fields; no
  `data`, no `markerEnd`. Include `"type": "step"` when authoring an edge by hand.

> **`next` vs `next_1` — don't mix them up.** In the `.flow` file the Start out handle is **`next`**.
> The running engine routes on **`next_1`**; that rename is done by the **deploy compiler** on the server,
> **not** by you. On a Start node write the canvas id **`next`** — never `next_1`. (Most other nodes' out
> dot *is* `next_1` on the canvas too; only Start / Flow Pointer `next`, Condition `true` / `false` and the
> Loop body `out` get renamed. The full table: `../field-rules.md` → *Handle ids*.)

## Size on the canvas & the snap grid (build precisely)

An agent placing nodes needs two numbers: **how big a node is** and **what the grid is**.

- **Most node cards are a fixed `170px` wide box** (`Card.Root w="170px"`) — the exceptions are **Parallel
  Context (200px)** and **Note (500px)**. A card does **not** grow as you type — on the card face the label
  and description are **truncated with `…`** to fit; the full values (Label ≤ **60**, Description ≤ **250**)
  live in the settings form, not on the card. A card gets **taller only when you open its Settings** panel
  (the form expands inline, downward); closed, it's a compact fixed height. So a node's footprint is
  predictable: **170px wide** for most nodes, short when closed.
- **The canvas has grid snap on:** `snapToGrid` with `snapGrid = [16, 16]`, and the background dots sit
  on the same **16px** grid. While dragging, a node snaps so its `position.x` / `position.y` land on
  **multiples of 16**. (A node **dropped** from the palette lands at the snapped cursor position; the
  `16 × 2 = 32px` offset applies when you **paste** a copied node.)
  <!-- UNVERIFIED (audit 2026-09-12): the 32px paste offset was not located in the canvas bundle; the 16px
  snap grid (snapGrid [16,16], snapToGrid on) is confirmed. -->

**Rules of thumb for an agent emitting `position` values:**

- Keep every `position.x` / `position.y` a **multiple of 16** (e.g. `208`, `176`, `384`) so nodes sit
  exactly where the canvas would snap them.
- A card is **170px** wide (≈ 11 grid cells). **Spacing follows the rule in `../best-practices.md` →
  *Canvas layout*:** step successive nodes **~432px** (27 cells) apart along the chain, and keep
  neighbouring branches at least that far apart on the cross axis, so every gap between cards is ≥ 1.5× a
  card. Overlap-free is not enough — the graph has to stay readable.
- The **out** dot sits at the bottom by default. The Rotate control moves it to another side and stores
  that as `data.handlePosition` — **cosmetic only**: it changes where the dot renders, never the wiring.

## The link to the agent (this is what trips people up)

For the flow an **agent** runs, the two names must line up with what's set on the agent in the admin
console:

- the flow **file name** must equal the agent's **Start Flow**, and
- the Start node's **label** must equal the agent's **Start Node**

— both **PascalCase** (capital first, one word), matched **exactly**. If they don't match, the agent
has no entry to run and simply **does nothing** — it's a *silent break* (nothing errors in the admin
form; the agent just never responds). So: decide the names once, and use the same ones in the flow
**and** on the agent. Don't invent a placeholder. (See `keen-admin-guide/03-spaces-and-agents.md`.)

## How other nodes reach it

Composition nodes address a flow by its `File-Label` entry, which resolves to a Start node's label:

- **Run Flow** / **Jump Flow** put a `File-Label` in their target — that `Label` is a start node's label.
- **Parallel Flow** / **Parallel Context** likewise launch a flow by its entry.

So a Start node isn't only "the beginning" — it's the **public address** other flows call.

## You can have many Start nodes

A flow file can hold **as many Start nodes as you like** — each one is the **entry gate for a defined
routine** inside that flow. They're not just "the top of the file"; think of each as a named door into
a distinct algorithm you've built on the canvas. Another flow can then knock on whichever door it
needs (its `File-Label`), instead of always entering from one fixed point. Each Start node's label is
its own `File-Label` address.

## ⚠️ Watch out for

- **The label is a contract.** A typo or a rename silently breaks **every** Run Flow / Jump Flow /
  Parallel that names it — the caller fails with **`E5001` "entry not found"**. Renaming a Start node
  is a breaking change; update every caller (and the agent's Start Node) with it.
- **Naming is strict** — one word, capitalised. `my-start` or `Start Flow` (with a space) are rejected;
  use `Start`.
- **A dangling out dot ends the flow immediately.** If the Start node's *out* isn't wired to anything,
  the flow starts and stops right there and does nothing. Always wire it onward.
- **Must match the agent** — see above; a start label that doesn't match the agent's Start Node means
  the agent never runs.

## ⏱ Performance

Near-zero. A Start node is a pure pass-through: it just hands control to whatever its *out* dot is
wired to. It stores nothing and does no work of its own.

---

*Next node: End Flow (`end-flow-node.md`).*
