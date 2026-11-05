# Summarizer Node

**Palette name:** `Summarizer`  ·  **Dots:** **In** (`in`) · **Fallback** (`error`) · **Out** (`next_1`)  ·
**Controls:** **Model** menu · **Instructions** menu · **Rotate**

**In one line:** the flow step that writes the chat's **rolling summary** — an LLM node's **Summary** dot leads
into it when a summary is due, it runs its own model with its own System prompt, and then the flow carries on
out of its **Out**.

> Base controls (drag handle, **Rotate**, two-level **Save**, **16px** snap) are as on Start — see
> `start-flow-node.md`. The Summary output itself is described in `agent-node.md` → *Chat memory*.

---

## What it is / what it's for

A **Summarizer** is a normal flow step with three dots, built for **chat memory**:

1. The **LLM node answers first**. The user already has the answer.
2. When the answer is done, the LLM node picks its exit: if a summary is **due** (**20 turns or 50 000 tokens**
   since the last one, counted after this answer, whichever comes first) and its **Summary** dot is wired, it
   exits through **Summary** into the Summarizer; otherwise it exits through its normal **Out**.
3. The Summarizer runs **as its own node**: its model and System prompt write the new summary (at most **1500
   tokens**), the platform saves it, and the flow continues out of the Summarizer's **Out**.

The summary never waits in front of an answer, and it never streams to the user or writes chat history.
**The chat stays busy while the Summarizer runs** (the flow is still running; the Send button stays off) — the
Chat SDK tells the UI with `onSummarizing(true / false)` so it can show "Compressing the conversation…"
(`agent-runner/docs/SDK-API.md`).

One Summarizer **may serve several LLM nodes**: wire each LLM node's `summary` dot into the same Summarizer's
`In`. Each LLM node keeps its own summary of its own chat.

## On the canvas — three dots

| Dot (label) | Handle id | Direction | Wire it to… |
|---|---|---|---|
| **In** | `in` (merge: many edges allowed) | input | an LLM node's **Summary** (`summary`) dot, **or** another Summarizer's **Fallback** — nothing else |
| **Fallback** (side) | `error` | output | **only** another **Summarizer's** `In` — a model failover (see below). One edge. |
| **Out** (bottom) | `next_1` | output | any node, like any Out — where the flow continues (see *Where the Out should go*). One edge. |

Header controls: **Model**, **Instructions**, **Rotate**. There is **no** General Settings panel (no name,
ID, session, request or description), no *Interact with DB*, no *Use tools*, no roles or turns.

## What happens when it runs

The platform runs the Summarizer under the **main LLM node's** identity (billing and storage stay the main
agent's), with **this node's** model and System prompt:

- If another replica or another tab already summarized (or it is no longer due), the Summarizer does nothing and
  exits through **Out**.
- On **success** the summary is saved and it exits through **Out**.
- On **failure** (timeout, provider error, a cut or empty or too-long summary, no credits, no model) nothing is
  saved and it exits through **Fallback** if that is wired, **else through Out** — a failed summary never stops
  the flow. The next due turn simply tries again.

### Fallback chains — model failover

Wire a Summarizer's **Fallback** to a second Summarizer's **In** (and that one's Fallback to a third, …) to try
another model when the first fails — for example a `gpt-4o-mini` Summarizer falling back to a
`claude-haiku-4-5-20251001` one. Each Summarizer in the chain has its own model and Instructions. Fallbacks
**must not loop** (the deploy refuses a loop). When the last Summarizer in the chain fails (no Fallback wired), the flow exits through
**its** Out.

### Where the Out should go

The Out is an ordinary Out: it continues **where the flow should go after a due turn**. That is normally the
**same place the LLM node's own Out leads** (for example the same End node, or the same Jump), so a due turn and
a normal turn end alike. **No validator rule checks this** — it is the flow author's job; wire
the two Outs to the same continuation, or use a **Jump Flow** node so both paths share one tail. A Summarizer
with no Out ends the flow there on a due turn (still valid, but only right if that is what you want).

## Menu 1 — Model

The same model picker as the LLM node: **company** (`anthropic` / `openai` / `google`), **model**, and its
parameters. **Max Tokens is capped at 1500** (slider maximum and default = the smaller of the model's value
and 1500), because the summary may not be longer than **1500 tokens**; a cut or empty summary is discarded.

**Choose the model for speed:** a fast **non-reasoning** model — `gpt-4o-mini`, `claude-haiku-4-5-20251001`, a
Gemini flash — with reasoning **none / low**. Reasoning tokens count toward the 1500-token cap, and a cut
summary is thrown away. A reasoning summarizer only produces a warning, but it will often fail. The whole
summarizing step has a **60-second** budget per prompt.

## Menu 2 — Instructions

**One System prompt**, in the same rich editor the LLM node uses — no *Add Turn*, no roles. It says *how* to
summarize; the platform sends the model the previous summary plus the new turns. A new node is pre-filled with
the recommended prompt below.

**Recommended summarizer System prompt** (language-neutral; this is the pre-filled text):

```text
You maintain a running summary of a conversation between a user and an AI agent.
You receive the previous summary (or "(none)") and the newest part of the conversation.
Write the updated summary of the WHOLE conversation so far.

Keep: facts the user stated, decisions made, names, numbers, dates, identifiers, the user's preferences and
constraints, tasks done, and open questions or promised next steps.
Drop: greetings, small talk, repetition, and wording that adds nothing.
Write in the language of the conversation. Be concise: plain short sentences or bullets, no headings.
Never invent anything that is not in the conversation. If something changed, keep the newest version.
Return only the summary text.
```

## What a Summarizer node looks like in the `.flow` file

```json
{
  "id": "summarizerNode_Qw3Er5Ty7Ui9",
  "type": "summarizerNode",
  "position": { "x": 560, "y": 656 },
  "data": {
    "label": "", "description": "",
    "labelNode": "Summarizer", "descriptionNode": "Writes the chat summary for an LLM node's Summary output",
    "open": false,
    "settings": {
      "llm": {
        "company": "openai", "model": "gpt-4o-mini",
        "parameters": { "temperature": 0.2, "maxTokens": 1500 }
      },
      "prompts": [ { "id": "p1", "role": "system", "content": "You maintain a running summary of a conversation ..." } ]
    }
  },
  "dragHandle": ".drag-handle__custom"
}
```

| Field | Value / rule | What it is |
|---|---|---|
| `id` | `summarizerNode_` + **12** `A–Za–z0–9` | id; the prefix carries the kind |
| `type` | `"summarizerNode"` | mandatory node kind |
| `settings.llm` | `{ company, model, parameters }` — **company + model required** | the summarizer's model (`maxTokens` ≤ 1500) |
| `settings.prompts` | exactly one `{ id, role: "system", content }` | the System prompt |
| *(none of)* | `agentId`, `agentName`, `sessionId`, `requestId`, `specialRules`, `description` | a Summarizer has no identity of its own — identity, billing and storage stay the **main** LLM node's |

**The edges** — the LLM node's `summary` dot into the Summarizer's `in`; the Summarizer's `next_1` (Out) onward; and,
for a failover, its `error` (Fallback) into a second Summarizer's `in`:

```json
[
  {
    "type": "step",
    "source": "agentNode_kM6oI3DsNdH3", "sourceHandle": "summary",
    "target": "summarizerNode_Qw3Er5Ty7Ui9", "targetHandle": "in",
    "id": "xy-edge__agentNode_kM6oI3DsNdH3summary-summarizerNode_Qw3Er5Ty7Ui9in"
  },
  {
    "type": "step",
    "source": "summarizerNode_Qw3Er5Ty7Ui9", "sourceHandle": "next_1",
    "target": "endNode_Zx8Cv1Bn4Mq2", "targetHandle": "in",
    "id": "xy-edge__summarizerNode_Qw3Er5Ty7Ui9next_1-endNode_Zx8Cv1Bn4Mq2in"
  },
  {
    "type": "step",
    "source": "summarizerNode_Qw3Er5Ty7Ui9", "sourceHandle": "error",
    "target": "summarizerNode_Lk2Jh4Gf6Ds8", "targetHandle": "in",
    "id": "xy-edge__summarizerNode_Qw3Er5Ty7Ui9error-summarizerNode_Lk2Jh4Gf6Ds8in"
  }
]
```

## The deploy rules (and the exact words)

`keen-validate` and the VS Code Problems panel say the same words as the deploy. Messages read
`flows/<file>: <node id> — <words>`.

| Rule | Result | Words |
|---|---|---|
| An LLM node's `summary` edges must be **exactly one**, to a **Summarizer** (an LLM node as the target is refused) | **refused** | `Summary output must connect to exactly one Summarizer node.` |
| A Summarizer reached by a Summary output or a Fallback needs `settings.llm` with company **and** model | **refused** | `A Summarizer node needs a model.` |
| A Summarizer's `In` takes only an LLM node's `summary` or a Summarizer's `error` | **refused** | `A Summarizer node's In takes only a Summary output or a Summarizer's Fallback.` |
| A Summarizer's `error` (Fallback) points to exactly one edge, to a Summarizer | **refused** | `A Summarizer node's Fallback connects only to a Summarizer node.` |
| Summarizer Fallbacks form a loop | **refused** | `Summarizer Fallbacks must not form a loop.` |
| A reasoning model / effort above none / low | warning | reasoning tokens count toward the 1500-token cap |
| The source LLM node has **Interact with DB** off (`skip-internal-database-interactions`) | warning | no history, so it never summarizes |
| A Summarizer no Summary output reaches | warning | `Summarizer node is not connected to any Summary output` |

No `summary` edge at all is fine. Several LLM nodes may share one Summarizer. Its Out (`next_1`) is checked like any
node's wiring but **not** against the LLM node's Out.

## ⚠️ Watch out for

- **Wire the Out.** On a due turn the flow continues from the Summarizer's Out, not from the LLM node's Out —
  point it at the same continuation. Nothing checks it for you.
- **The chat is busy while it runs** — up to the 60-second budget. Keep Send off and show the "compressing" line
  (`onSummarizing`).
- **Pick a model** — a Summarizer with no company + model on a used Summary output refuses the deploy.
- **A fast non-reasoning model**, `maxTokens` ≤ 1500.
- **Fallback goes only to another Summarizer**, never an LLM node or an End node, and never in a circle.
- **Flows made with an LLM node as the Summary target (an earlier draft)** — no longer valid; replace it with a
  Summarizer node.

---

*Next node: Note (`note-node.md`). Back to the index: `../README.md`.*
