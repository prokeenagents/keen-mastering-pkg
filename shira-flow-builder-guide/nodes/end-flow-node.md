# End Flow Node

**Palette name:** `End Flow`  ·  **Dots:** **In** (`in`) only — no output  ·  **Settings:** Label,
Terminate dictionary, Description

**In one line:** the **terminator** — it marks where a flow ends; when control reaches it, that flow is
finished.

> Base controls (drag handle, **Settings** toggle, **Rotate**, two-level **Save**, **170px** card,
> **16px** snap) are as on Start — see `start-flow-node.md`.

---

## What it is / what it's for

An **End Flow** node is where a flow **stops**. It has an **In** dot and **no output** — reaching it
produces the flow's terminator (`{ final: true }`). Every finished path should arrive at an End node
(a path that just runs out of wiring also stops, but an explicit End is clearer and unlocks the
terminate-dictionary option below).

- For a **root** flow, hitting End finishes the whole run.
- For a **sub-flow** (Run Flow / Parallel Context / Parallel Flows), hitting End finishes *that*
  sub-flow — control returns to the caller (Run Flow) or the result merges/settles (the parallels).

## Settings

| Field | Required | What it is |
|---|---|---|
| **Label** | recommended | A display name for the node (card title). Stored in `data.settings.value` + `.label` (+ `data.label`). Just a name — no naming rule. |
| **Terminate dictionary** | no (default off) | `data.settings.terminateDictionary` — a **boolean**: free this flow's dictionary from memory **the moment the flow ends** (see below). |
| **Description** | no | A plain note; no effect on running. |

### `Terminate dictionary` — what it actually does

When `terminateDictionary: true`, the engine **eagerly deletes this flow's own working dictionary** from
memory as soon as the flow reaches this End — instead of leaving it to expire on the normal **60 s TTL**.
Verified in `taskMgr` (line ~632): on the flow terminator, if the setting is `true` **and the flow owns
its dict**, the dict key is deleted.

Precisely (this is the nuance):

- **"Owns its dict"** = a **root** run, a **Parallel Context** clone, or a **Parallel Flows** sibling —
  each keyed by its own `flowId`. For those, the setting frees that dict immediately.
- **A Run Flow / Jump Flow child does NOT own its dict** (it shares the caller's) — so
  `terminateDictionary` is **skipped** there (deleting it would pull the dictionary out from under the
  still-running parent). No harm, just no effect.

So it's a **memory-reclaim** knob. The motivating case is a **wide parallel fan-out**: each branch owns a
dict it no longer needs at its End, and terminating eagerly reclaims that memory instead of holding it
for the TTL. For a normal small flow you can leave it off — the 60 s TTL cleans up anyway.

> It only affects the **dictionary that belongs to this flow** — not the session, not another flow's
> dictionary. (This matches your note: "the dictionary that pertains to the node['s flow]".)

## What an End node looks like in the `.flow` file

```json
{
  "id": "endNode_w5BlB6SQOOVl",
  "type": "endNode",
  "position": { "x": -32, "y": 592 },
  "data": {
    "label": "Terminal",
    "description": "Exit point from the flow",
    "labelNode": "End Flow",
    "descriptionNode": "Flow terminal",
    "open": false,
    "settings": { "value": "Terminal", "label": "Terminal", "terminateDictionary": true }
  },
  "dragHandle": ".drag-handle__custom"
}
```

| Field | Value / rule | What it is |
|---|---|---|
| `id` | `endNode_` + **12** `A–Za–z0–9` | id; the `endNode_` prefix carries the kind |
| `type` | `"endNode"` | mandatory node kind |
| `data.settings.terminateDictionary` | `true` / `false` (literal) | eagerly free the owned dict on end |
| `data.settings.value` / `.label` / `data.label` | the **Label** | node title (display only) |
| `data.labelNode` | **fixed** `"End Flow"` | card title |
| `data.descriptionNode` | **fixed** `"Flow terminal"` | card subtitle |
| `dragHandle` | `".drag-handle__custom"` | fixed |

### Wiring — input only

End has **one dot: In** (`in`), no output — you wire **into** it, never out of it. Edges carry
`"type": "step"` plus `{ id, source, sourceHandle, target, targetHandle }`, with
`"target": "endNode_…"`, `"targetHandle": "in"`.

## ⚠️ Watch out for

- **No output** — nothing runs after an End; it's the terminator of its flow.
- **`terminateDictionary` only frees an *owned* dict** — it's a no-op on a Run/Jump child (shared dict);
  use it on root runs and parallel branches to reclaim memory.
- **It doesn't touch the session** — only this flow's dictionary.

## ⏱ Performance

Near-zero. With `terminateDictionary` on, it does one extra dict delete on the way out — a small win for
wide fan-outs, negligible otherwise.

---

*Node pages so far: Start, End, Condition, Loop, Run Flow, Jump Flow, Join, Assignment, Parallel Context,
Parallel Flows, Flow Pointer. Still to come: Script, Agent (LLM), Note.*
