# Note Node

**Palette name:** `Note`  ·  **Dots:** **none** — no inputs, no outputs  ·  **Settings:** Label (the note
text), Description  ·  **Controls:** drag handle + **Settings** toggle only (no Rotate)

**In one line:** a **sticky note** on the canvas — a comment for humans. It is **not part of the flow**:
it has no dots, so it never runs and can never be wired.

> Base controls (drag handle, two-level **Save**, **16px** snap) are as on Start — see
> `start-flow-node.md`. Note is wider than other cards (**500px**) and has **no Rotate** (nothing to
> rotate — it has no handles).

---

## What it is / what it's for

A **Note** node is pure documentation on the canvas — leave yourself or a teammate a reminder next to the
part of the flow it explains. The engine **never executes it**, and because it has **no input or output
dot**, it **cannot be connected to anything**. It exists only in the `nodes` list; it contributes **no
edges**.

## Settings

| Field | Required | What it is |
|---|---|---|
| **Label** | **yes** | the **note text** (what the card displays). Min 1, max **160** characters. |
| **Description** | no | a secondary note. |

There is no interpolation here and no naming rule — it's plain text for humans.

## What a Note node looks like in the `.flow` file

```json
{
  "id": "noteNode_Xy12Ab34Cd56",
  "type": "noteNode",
  "position": { "x": 640, "y": 120 },
  "data": {
    "label": "Remember: the offer-agent expects dictionary.items to be set first.",
    "description": "",
    "labelNode": "Note",
    "descriptionNode": "Write your notes here",
    "open": false,
    "settings": { "value": "Remember: …", "label": "Remember: …" }
  },
  "dragHandle": ".drag-handle__custom"
}
```

| Field | Value / rule | What it is |
|---|---|---|
| `id` | `noteNode_` + **12** `A–Za–z0–9` | id; the `noteNode_` prefix carries the kind |
| `type` | `"noteNode"` | mandatory node kind |
| `data.label` | the note text | what the card shows |
| `data.settings.value` / `.label` | mirror the note text | stored the same as the label |
| `data.labelNode` | **fixed** `"Note"` | card title |
| `data.descriptionNode` | **fixed** `"Write your notes here"` | card subtitle |
| `dragHandle` | `".drag-handle__custom"` | fixed |

> **It never appears in `edges`.** A Note has no handles, so there is nothing to wire — don't try to
> connect it (the canvas won't let you, and a hand-added edge to it would be invalid).

## ⚠️ Watch out for

- **It doesn't run.** A Note changes nothing about execution — it's a comment.
- **It can't be wired** — no input, no output. If you wanted a "do nothing then continue" step, that's a
  **Join** (a pass-through with dots), not a Note.

## ⏱ Performance

None — it's never executed.

---

*That's all 14 node types. Back to the index: `../README.md`.*
