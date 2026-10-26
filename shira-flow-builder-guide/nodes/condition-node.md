# Condition Node

**Palette name:** `Condition`  ·  **Dots:** one **in** (top) · two out — **True** (`true`) and **False**
(`false`)  ·  **Settings:** Condition expression (required), Node Description (optional)

**In one line:** a fork — it evaluates one boolean **expression** and sends the flow down the **True**
branch or the **False** branch.

> Base controls (drag handle, the **Settings** sliders toggle, **Rotate**, the two-level **Save**, the
> fixed **170px** card, the **16px** snap grid) are identical to the Start node — see
> `start-flow-node.md` → *On the canvas* and *Size on the canvas & the snap grid*. This page covers only
> what's different: the two output dots and the expression.

---

## What it is / what it's for

A **Condition** node is an *if / else* on the canvas. It holds a single **boolean expression**; when the
flow reaches it, the engine evaluates that expression and routes:

- expression **true** → out of the **True** dot (`true`),
- expression **false** → out of the **False** dot (`false`).

It's the primary way a flow branches on data it's holding — "is the score above 25?", "did the user
say yes?", "is this list empty?".

## On the canvas

It renders as a **yellow diamond** card titled **Condition**, subtitle **"Set condition flow direction"**,
with one **In** dot on top and two labelled output dots: **True** on the left, **False** on the right.
The card face shows the expression (truncated with `…`), and the description under the diamond.

Wire it: the **In** dot from the previous node; the **True** dot to whatever should run when the
condition holds; the **False** dot to the other path. Either output may be left unwired — that branch
simply ends there (`keen-validate` warns about it, so leave one open only on purpose).

## Settings

| Field | Required | What it is |
|---|---|---|
| **Condition** | **yes** | The **boolean expression** to evaluate (see below). This is the whole point of the node. Stored in `data.settings.value`. |
| **Description** | no | A plain note; no effect on running. Form cap **≤ 250** chars. |

There is **no naming rule** here — the Condition field is an **expression**, not an identifier, so the
PascalCase rule that governs Start labels does **not** apply.

## What a Condition node looks like in the `.flow` file

```json
{
  "nodes": [
    {
      "id": "conditionNode_E0eqDp5b0fUs",
      "type": "conditionNode",
      "position": { "x": 304, "y": 304 },
      "data": {
        "label": "${dictionary.test} > 25",
        "description": "Welcome to condition",
        "labelNode": "Condition",
        "descriptionNode": "Set condition flow direction",
        "open": false,
        "settings": { "value": "${dictionary.test} > 25" }
      },
      "dragHandle": ".drag-handle__custom"
    }
  ],
  "edges": []
}
```

| Field | Value / rule | What it is |
|---|---|---|
| `id` | `conditionNode_` + **12** `A–Za–z0–9` | the id — the `conditionNode_` prefix is how the engine knows the kind |
| `type` | `"conditionNode"` | mandatory node kind |
| `data.settings.value` | the **expression** | the boolean expression the engine evaluates — **use `${dictionary.…}` / `${session.…}` placeholders** (bare `dictionary.x` throws — see below) |
| `data.label` | **mirrors the expression** | shown on the card face; the builder copies the expression here for a readable title (visual only) |
| `data.description` | your note | shown under the diamond |
| `data.labelNode` | **fixed** `"Condition"` | card title — always this |
| `data.descriptionNode` | **fixed** `"Set condition flow direction"` | card subtitle — always this |
| `data.open` | `true` / `false` | settings panel open state |
| `dragHandle` | `".drag-handle__custom"` | fixed |

### Wiring the two outputs (edges)

The output handle ids are **`true`** and **`false`** (the input is **`in`**). So the two edges look like:

```json
{
  "id": "xy-edge__conditionNode_E0eqDp5b0fUstrue-<targetId><targetHandle>",
  "type": "step",
  "source": "conditionNode_E0eqDp5b0fUs",
  "sourceHandle": "true",
  "target": "<targetNodeId>",
  "targetHandle": "in"
}
```

— and a second edge with `"sourceHandle": "false"` to the other branch. Each edge carries `"type":
"step"` plus `{ id, source, sourceHandle, target, targetHandle }`.

## The expression — how it's evaluated (the #1 gotcha)

The Condition value is **not** free JavaScript and is **not** written with bare `dictionary.x`. It is:
**`${...}` placeholders → substituted with their values → a small locked-down expression → evaluated to
a boolean.** (Verified in `helpers/condition.ts`.)

How it runs:

1. The engine scans the expression for `${dictionary.<dot.path>}` and `${session.<flatKey>}` and replaces
   each with the **JSON value** it resolves to (a missing value becomes the literal `null`).
2. It parses the **result** with jsep and evaluates it to true/false.

So with `dictionary.test` holding `30`, the expression **`${dictionary.test} > 25`** becomes `30 > 25`
→ **true** → out the **True** dot.

> ⚠️ **You must wrap the data reference in `${...}`.** A **bare** `dictionary.test > 25` does **not**
> work: nothing gets substituted, jsep then sees `dictionary.test` as a **member access**, and the
> evaluator **throws** — *"Member access is not allowed"* / *"Identifier … is not allowed (placeholders
> must be dictionary.* or session.*)"*. The canvas form accepts the bare form unvalidated, but
> `keen-validate` rejects it; the JSON above uses the **runnable** form `${dictionary.test} > 25`.

**What you can write** (anything else throws — the evaluator is deliberately minimal):

- **Comparison:** `==`  `===`  `!=`  `!==`  `>`  `<`  `>=`  `<=`
- **Arithmetic:** `+`  `-`  `*`  `/`  `%`
- **Logical / short-circuit:** `&&`  `||`  `??`   ·   **Unary:** `!`  `-`  `+`   ·   **Ternary:** `a ? b : c`
- **Operands:** number / string / boolean / null **literals**, and `${dictionary.*}` / `${session.*}`
  placeholders (resolved to values before evaluation).

**Rejected (throws):** bare identifiers, member access (`a.b`), function calls (`foo()`), array literals
`[…]`, and multiple statements. Keep it to one comparison built from literals + `${…}` placeholders.

**Where the data comes from:** `${dictionary.*}` reads the **current flow's** dictionary (nested
dot-paths OK); `${session.*}` reads the **whole-run** session (**flat** keys only — `${session.a.b}` is
the single key `"a.b"`, it does not nest). Condition only **reads**; it writes nothing.

## ⚠️ Watch out for

- **Two outputs — wire the branch you need.** An unwired **True** or **False** dot means that path just
  ends; make sure the branch you rely on is connected.
- **Wrap each data reference in `${...}`.** A bare `dictionary.x` throws *"Member access is not allowed"*
  — see the expression section. The runnable form is `${dictionary.x} > 25`.

## ⏱ Performance

Near-zero — it evaluates one small expression and routes. It stores nothing of its own.

---

*Next node: Loop (`loop-node.md`).*
