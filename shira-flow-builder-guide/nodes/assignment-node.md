# Assignment Node

**Palette name:** `Assignment`  ·  **Dots:** **In** (`in`) · **Out** (`next_1`)  ·  **Settings:** Label,
Dictionary Key/Value Pairs (the point of the node), Description

**In one line:** writes one or more **key → value** pairs into the **current dictionary** — the way you
put data *into* the flow's scratchpad.

> Base controls (drag handle, **Settings** toggle, **Rotate**, two-level **Save**, **170px** card,
> **16px** snap) are as on the Start node — see `start-flow-node.md`.

---

## What it is / what it's for

An **Assignment** node **sets properties on the current flow's `dictionary`**. You list **Key/Value
Pairs**; when the node runs, each pair's value is resolved and stored under its key in the dictionary,
then control continues out **Out**. It's how you seed or update working data mid-flow (a constant, a
computed value, a copy of something already in the dictionary/session).

It writes the **dictionary only** (the current flow's) — never the session, never agent state.

## On the canvas

An **orange `{ }` icon** card titled **Assignment**, subtitle **"Set properties to the current
dictionary"**, an **In** dot on top and an **Out** dot below. Open **Settings** to see the **Label**, a
**Dictionary Key/Value Pairs (N)** editor with an **+ Add Pair** button and an **✕** per row, and the
**Description**.

## Settings

| Field | Required | What it is |
|---|---|---|
| **Label** | recommended | A display name for the node (card title). Stored in `data.settings.value` + `data.settings.label` (+ `data.label`). Not an identifier, no naming rule — just a title. |
| **Dictionary Key/Value Pairs** | optional | The list that does the work — `data.settings.keyValuePairs`, an array of `{ key, value }` (up to **10**; keys ≤ 100, values ≤ 200 chars; **duplicate keys rejected**). Each writes `dictionary[key] = <resolved value>`. Zero pairs is a valid no-op. |
| **Description** | no | A plain note; no effect on running. |

### `key` — a flat, literal dictionary property

Each `key` is a **literal top-level property name** on the dictionary — the engine does
`dictionary[key] = …` (bracket assignment). It is **not** interpolated and **not** a nested path:
`key: "a.b"` creates a literal property named `"a.b"`, it does **not** create `a` → `b`. Use simple
top-level names (`prop1`, `userName`, `total`).

### `value` — interpolated, and stored **exactly as resolved** (read this)

Each `value` goes through the `${...}` resolver (`evaluateValue`, allowed types **string / number /
boolean / array**):

- **A plain literal is stored as-is — as a *string*.** `value: "1"` stores the **string `"1"`**, not the
  number `1`. **There is no numeric/boolean coercion.** So the example pairs produce:

  ```json
  { "prop1": "1", "prop2": "2" }   // strings — NOT { prop1: 1, prop2: 2 }
  ```

- **To store a real number / boolean / array**, use a placeholder that resolves to that type — a
  **whole-string** placeholder **preserves the type**: `value: "${dictionary.count}"` where `count` is a
  number stores a **number**. And `value: "${Array([1, 2, 3])}"` stores the **array** `[1,2,3]`.
- **Mixed text + placeholder** → concatenated **string**: `"Hello ${dictionary.name}"` → `"Hello Ann"`
  (primitives via `String()`, a non-primitive slots in as empty string).
- **Objects are not allowed here** — a placeholder resolving to a plain object yields **`null`** (only
  string/number/boolean/array pass the type gate). Arrays are fine.
- `${dictionary.*}` reads the **current** flow's dictionary (nested dot-paths OK); `${session.*}` reads
  the **whole-run** session (**flat** keys only).

## What an Assignment node looks like in the `.flow` file

```json
{
  "nodes": [
    {
      "id": "assignmentNode_0zrqPkDvJIHc",
      "type": "assignmentNode",
      "position": { "x": 112, "y": 256 },
      "data": {
        "label": "Set Dict values",
        "description": "Inject values in current dictionary",
        "labelNode": "Assignment",
        "descriptionNode": "Set properties to the current dictionary",
        "open": true,
        "settings": {
          "value": "Set Dict values",
          "label": "Set Dict values",
          "keyValuePairs": [
            { "key": "prop1", "value": "1" },
            { "key": "prop2", "value": "2" }
          ]
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
| `id` | `assignmentNode_` + **12** `A–Za–z0–9` | id; prefix carries the kind |
| `type` | `"assignmentNode"` | mandatory node kind |
| `data.settings.keyValuePairs` | `[{ key, value }, …]` | the writes — `dictionary[key] = resolve(value)` |
| `data.settings.value` / `.label` / `data.label` | the **Label** text | node title (display only) |
| `data.labelNode` | **fixed** `"Assignment"` | card title |
| `data.descriptionNode` | **fixed** `"Set properties to the current dictionary"` | card subtitle |
| `data.open` | `true` / `false` | settings panel open state |
| `dragHandle` | `".drag-handle__custom"` | fixed |

### Wiring (edges)

**In** from the previous node, **Out** (`next_1`) to the next. Edges carry `"type": "step"` plus
`{ id, source, sourceHandle, target, targetHandle }`:

```json
{
  "id": "xy-edge__assignmentNode_0zrqPkDvJIHcnext_1-<afterId>in",
  "type": "step",
  "source": "assignmentNode_0zrqPkDvJIHc",
  "sourceHandle": "next_1",
  "target": "<afterNodeId>",
  "targetHandle": "in"
}
```

## ⚠️ Watch out for

- **Plain values are strings.** `1` becomes `"1"`. If a later Condition does `${dictionary.prop1} > 25`
  it compares a **string** — wrong results. Store numbers via `${dictionary.someNumber}` (or type a value
  a later node coerces intentionally).
- **`key` is flat & literal** — no nesting via dots, no `${}`; it's a plain property name.
- **Objects don't store** — a value resolving to a plain object becomes `null` here (arrays are fine).
- Writes the **current** dictionary only — not session, not another flow's dictionary.

## ⏱ Performance

Near-zero — a few property writes + one dictionary commit. Cost scales only with how many/large the
values are.

---

*Next node: Script (`script-node.md`).*
