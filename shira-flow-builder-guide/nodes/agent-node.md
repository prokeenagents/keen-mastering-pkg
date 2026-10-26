# Agent (LLM) Node

**Palette name:** `LLM`  ·  **Dots:** **In** (`in`) · **Out** (`next_1`) · **Fallback** (`error`)  ·
**Settings:** three panels — **General**, **Prompt**, **LLM**

**In one line:** the brain — it sends a conversation to a language model, gets the answer back, and can
**call tools** to fetch things or run sub-flows before it replies.

> Base controls (drag handle, **Rotate**, two-level **Save**, **170px** card, **16px** snap) are as on
> Start — see `start-flow-node.md`. Data stores: `../data-model.md`. Tool calling: `../tool-calling.md`.

---

## What it is / what it's for

An **Agent (LLM)** node runs a **language model** (Claude, Gemini, GPT, etc.). It gathers a conversation —
your scripted prompts + the chat history + the user's latest message — sends it to the model, and the
model's answer becomes the node's output. If you give the agent tools, it can **call a tool**, read the
result, and keep reasoning before it gives a final answer (see `../tool-calling.md`).

The card shows **three settings icons** (top-right), each opening a panel: **General**, **Prompt**, and
**LLM**. Plus **Rotate**.

## On the canvas — three dots

| Dot (label) | Handle id | Direction | Wire it to… |
|---|---|---|---|
| **In** (top) | `in` | input | the previous node |
| **Out** (bottom) | `next_1` | output | what runs after a **normal** answer (this is also where the tool loop exits to) |
| **Fallback** (side) | `error` | output | what runs if the **LLM call fails** (see Fallback below) |

---

## Panel 1 — General Settings (identity)

| Field | Required | Interpolated? | What it is |
|---|---|---|---|
| **Agent Name** | **yes** | ✅ | a human name for the agent (`agentName`, e.g. `Agent One`). |
| **Agent ID** | **yes** | ✅ engine | the agent's **slug** (`agentId`, e.g. `agent-one`) — identifies whose conversation this is. Empty → `E6101`. The engine would resolve a placeholder, but the **canvas form accepts a kebab-case slug only** (no `${}`, no digits), so treat it as a literal. |
| **Session ID** | no | ✅ | **override** (`sessionId`). Leave **empty** normally. |
| **Request ID** | no | ✅ | **override** (`requestId`). Leave **empty** normally. |
| **Description** | no | — | a plain note. |

**Session ID / Request ID — pay attention here.** They're **optional overrides**, and both accept
`${dictionary.*}` / `${session.*}` placeholders. **Leave them blank** and the agent uses the run's natural
ids (the normal case). Set one only to deliberately point this agent turn at a **specific slot** in the
chat history — e.g. `"${dictionary.chat.threadId}"`. A blank field (or a placeholder that resolves to
empty) **falls back** to the run's ids automatically. ⚠️ Do **not** try to force them to an empty value —
an empty session/request id breaks how the turn is recorded (the chat display would show nothing).

## Panel 2 — Prompt Settings (the scripted conversation)

Here you author the **conversation prompts** — a list of turns, each with a **role**:

- **Roles:** **System** (the agent's standing instructions), **User** and **Assistant** (scripted
  example turns / few-shot). At runtime `developer` maps to system and `model` to assistant, but author
  with **System / User / Assistant**.
- Each turn is written in a **rich Markdown editor** (H1–H3, bold, lists, code, …). Markdown is an
  **authoring convention** — the engine passes the text through as-is (it substitutes `${…}` placeholders
  but does not otherwise transform Markdown).
- **`content` is interpolated** — `${dictionary.*}` / `${session.*}` resolve before the model sees it.
  The **role** is literal.
- Add turns with **+ Add Turn**; reorder / delete with the arrows / ✕.

> The **System** prompt is also where you **teach the agent about tools** — the `<SYSTEM CALL>` instruction
> and the tool catalogue live here (the engine does not generate them). See `../tool-calling.md` §5.

**What the model actually receives** = your authored prompts **＋** up to **50** prior turns from the chat
history (each becomes a user + an assistant message) **＋** the **live** latest user message, all in order,
with adjacent same-role turns merged. (During a tool loop the current exchange's tool turns are kept in
full; past tool turns are dropped as noise.)

## Panel 3 — LLM Settings (model & behaviour)

| Setting | What it is | Interpolated? |
|---|---|---|
| **LLM Selection** | `llm.company` (e.g. `anthropic`, `google`) + `llm.model` (e.g. `claude-opus-4-5`); the UI also stores an internal `llm.modelId`. | ❌ literal |
| **Sampling: Temperature *or* Top p** | pick **one** — Temperature (0–2) or Top p (0–1). Stored under `llm.parameters`. | ❌ |
| **Max Tokens** | the answer length cap (`llm.parameters.maxTokens`). | ❌ |
| **Effort** | for reasoning-capable models — the thinking effort the model declares (e.g. **low / medium / high**, plus **max** on `claude-opus-4-7`; per model in the table below). | ❌ |
| **Special Rules → Interact with DB** | ON by default. **OFF** adds `specialRules: [{type:'skip-internal-database-interactions'}]` — the turn is **not** loaded from / saved to chat history (a transient sub-agent). | ❌ |
| **Special Rules → Use tools** | ON by default. **OFF** adds `specialRules: [{type:'skip-internal-tooling'}]` — the engine **won't** parse `<SYSTEM CALL>` blocks, so the agent can't call tools (its raw text is the answer). | ❌ |

### Available providers & models (don't default to one)

The engine supports **three providers** — **`anthropic`**, **`google`**, **`openai`** — and the
**selectable models come from the extension's model list** (the "**N models**" chip in the panel, fed by
the `flowBuilder.aiModels` setting / a pasted `models.json`). **This list is configurable**, so check the
panel for the live roster — but the **engine's own model registry is the authority**: a `model` name absent
from it fails the turn with `E6101` ("Model record not found") no matter what the panel offered. At the
time of writing the engine registry holds these 24:

| `company` | `model` (model_name) | Sampling | Max tokens | Reasoning knob |
|---|---|---|---|---|
| anthropic | `claude-opus-4-5` · `claude-opus-4-5-20251101` | temperature **XOR** top_p | 8192 (≤64000) | `effort`: low/medium/high |
| anthropic | `claude-opus-4-6` | temperature XOR top_p | 8192 (≤128000) | — (`effort` is **ignored by the engine** for this model) |
| anthropic | `claude-opus-4-7` | **none sent** — the engine strips temperature/top_p for this model | 8192 (≤128000) | `effort`: low/medium/high/**max** |
| anthropic | `claude-sonnet-4-6` | temperature XOR top_p | 8192 (≤64000) | — (`effort` is **ignored by the engine** for this model) |
| anthropic | `claude-sonnet-4-5` · `claude-sonnet-4-5-20250929` | temperature XOR top_p | 8192 (≤64000) | — |
| anthropic | `claude-haiku-4-5-20251001` | temperature XOR top_p | 8192 (≤64000) | — |
| google | `gemini-2.0-flash-001` · `gemini-2.5-flash` · `gemini-2.5-pro` · `gemini-flash-latest` | temperature + top_p | ≤65536 | — |
| google | `gemini-3-flash-preview` | temperature + top_p | ≤65536 | `thinkingLevel`: **LOW / HIGH only** (MINIMAL is dropped → HIGH) |
| google | `gemini-3.1-pro-preview` | temperature + top_p | ≤65536 | `thinkingLevel`: **LOW / HIGH only** (MEDIUM is dropped → HIGH) |
| google | `gemini-3.1-flash-lite-preview` | temperature + top_p | ≤65536 | `thinkingLevel`: **LOW / HIGH only** (MINIMAL/MEDIUM are dropped → HIGH) |
| openai | `gpt-4.1-2025-04-14` · `gpt-4o` · `gpt-4o-mini` | temperature + top_p | ≤16384 | — |
| openai | `o1` · `o4-mini` | (fixed) | ≤100000 | `reasoningEffort`: low/medium/high |
| openai | `gpt-5.5` · `gpt-5.4` · `gpt-5.4-mini` · `gpt-5.4-nano` | temperature (5.5/mini/nano fixed=1; 5.4 none) | ≤128000 | `reasoningEffort`: none/low/medium/high/xhigh |

Notes for building a `.flow`:
- The agent node's `llm` block needs `company` + `model` (the `model_name` above); the UI also stores a
  numeric `modelId` (the model's `id`), which is **UI-internal — the engine ignores it**, so it's cosmetic
  when hand-authoring.
- **Anthropic**: `temperature` and `top_p` are **mutually exclusive** — set one, not both.
- **Reasoning knob names differ by provider** (`effort` / `reasoningEffort` / `thinkingLevel`) — the panel
  shows the right control per model; when hand-authoring, use the knob the model actually declares **and
  only the values in the table above** (what the model declares *and* the engine sends): Anthropic
  `effort` is sent **only** for `claude-opus-4-5*` (low/medium/high, or 0/1/2) and `claude-opus-4-7`
  (low/medium/high/max); Google `thinkingLevel` = LOW/HIGH (or 0/1) on Gemini 3 — any other value is
  dropped and Gemini 3 then defaults to HIGH — while Gemini 2.5 takes a numeric `thinkingBudget`; OpenAI
  `reasoningEffort` = low/medium/high on `o1` / `o4-mini` and none/low/medium/high/xhigh on `gpt-5.4*` /
  `gpt-5.5`. (The engine's parser also passes `max` for any Anthropic model and `minimal` for OpenAI, but no
  registered model declares them — `max` on opus-4-5 or `minimal` anywhere is left to the provider to
  reject.)
- **Don't just default to Anthropic** — pick the provider/model that fits (cost, speed, reasoning). A
  cheap `gemini-*-flash` or `gpt-4o-mini` is fine for a simple tool agent; a reasoning model for hard
  planning.

The LLM configuration is **literal** — placeholders don't apply to model/params/rules. **Effort** maps to
the model's **reasoning** knob and is **provider-specific**: Anthropic uses `effort`, sent **only** for
`claude-opus-4-5*` (low/medium/high) and `claude-opus-4-7` (low/medium/high/max) and silently ignored on
every other Anthropic model (including opus-4-6 and sonnet-4-6); OpenAI reasoning models (`o1`, `o4-mini`,
`gpt-5.4*`, `gpt-5.5`) use `reasoningEffort` with the values in the table (and a separate completion-token
cap); Google uses `thinkingLevel` LOW/HIGH on Gemini 3 (other values are dropped → HIGH) and a numeric
`thinkingBudget` on Gemini 2.5. The engine applies a knob only where that provider path supports it and
ignores it otherwise.

---

## How the agent gets its input (the trigger)

The agent's "what the user just said" comes from the **conversation** (see `../business-objects.md`), not
from the dictionary or a wire. At run start the platform puts the user's message into the conversation
under this agent; the node reads the **newest user message** for this agent as its live prompt. (In a
`Parallel Context` fan-out, each run reads its own session's message so the clones don't cross wires.)

## Getting the answer back out

- **Normally**, the model's answer flows into the **conversation** (so a later Script can read it with
  `Agent.getAgentLastResponse('agent-one')`), and the node continues out **Out**.
- **Optionally**, set `agentResponse: true` + `agentResponseProperty: "<name>"` to also drop the answer
  into the **current dictionary** at that property (text answers only) — handy to pass it straight to the
  next node via `${dictionary.<name>}`.

## Tools — calling flows & scripts

If "Use tools" is on and you've taught the agent the tool format in its System prompt, the model can emit
a `<SYSTEM CALL>` block to run a **flow tool** or **script tool**, get the result, and continue. The full
mechanics (the block grammar, the loop, how many messages, the registry) are in **`../tool-calling.md`** —
this is the heart of multi-step agents.

## Fallback — when the `error` edge fires (verified)

The **Fallback** (`error`) dot fires when the **LLM/provider call fails** — e.g. **auth error**
(bad/missing API key), **rate-limit / capacity**, **timeout**, an upstream **4xx/5xx**, or a transport
error — **and** when the node's **configuration is broken** (missing `agentId` / `agentName` / `llm`, an
unknown provider or model — `E6101`; no user message to answer — `E6002`). Both route to **Fallback** (if
you wired it). (A provider failure is also **recorded** to the
chat history as the answer; a pre-call config error is not.)

It does **NOT** fire for:
- a **bad `<SYSTEM CALL>`** or an **unknown tool** — the engine re-loops the agent with a short corrective
  user message instead (see `../tool-calling.md`);
- a **successful but empty / "refusal"** answer — that's a normal `text` answer → **Out**;
- a **cancel** — that's a cancellation, handled separately.

⚠️ **If the call fails and you did NOT wire the Fallback edge, the flow continues out `Out`** with the
error text as the agent's "answer" (and it's recorded) — the flow never dead-ends. So: wire **Fallback**
when you want to handle "the model broke / no credits" deterministically.

### Fallback pattern — model failover (2–3 levels)

The **primary purpose** of the Fallback edge is **model failover**: if the specific LLM/provider is down,
over capacity, or throws (auth, rate-limit, timeout, 5xx), the `error` edge lets you **retry the same turn
on a different model** instead of failing the whole run. Wire Agent A's **Fallback → Agent B**, where B is
the same agent (same `agentId`, same prompts, same conversation) but its **LLM Settings point at a
different provider/model**. The user still gets an answer; they never see the outage.

**Two to three levels is plenty:**

- **Level 1** — your primary model (e.g. `anthropic / claude-opus-4-6`).
- **Level 2** — a **different provider** as a hot spare (e.g. `google / gemini-2.5-pro` or `openai / gpt-…`),
  wired from Level 1's **Fallback**.
- **Level 3 (optional)** — a cheap, almost-always-up model (e.g. a `…-flash` / `…-mini`), from Level 2's Fallback.

Chaining more than ~3 rarely earns its keep: if three independent providers are all failing at once, a
fourth won't save the run, and every extra level only adds latency to the unhappy path.

**The last level always degrades gracefully.** Its Fallback (or, if it's the final agent, its `Out`) must
lead to a node that **tells the user there is a problem** — a fixed, friendly message like *"the assistant
is temporarily unavailable, please try again shortly."* (an Assignment/Script that sets that text, or an
End that returns it). Never let the final fallback dead-end or surface a raw provider error to the user —
the **last word is always a clear, human "something went wrong on our side."**

> **Use different providers across levels, not just different models of the same one.** A provider-wide
> outage or a bad API key takes out every model under that `company` at once, so a same-provider fallback
> would fail for the same reason. Cross-provider failover is what actually buys the resilience.

## What an Agent node looks like in the `.flow` file

```json
{
  "id": "agentNode_kM6oI3DsNdH3",
  "type": "agentNode",
  "position": { "x": 240, "y": 656 },
  "data": {
    "label": "", "description": "This is the initial agent",
    "labelNode": "LLM", "descriptionNode": "Use LLM processor",
    "open": true, "openLLM": false, "openPrompt": false,
    "settings": {
      "sessionId": "", "requestId": "",
      "agentId": "agent-one", "agentName": "Agent One",
      "llm": {
        "company": "anthropic", "model": "claude-opus-4-5", "modelId": 4927,
        "parameters": { "temperature": 1, "maxTokens": 8192, "effort": 1 }
      },
      "specialRules": []
    }
  },
  "dragHandle": ".drag-handle__custom"
}
```

With **Use tools** turned off, `specialRules` carries the rule:

```json
"specialRules": [ { "type": "skip-internal-tooling" } ]
```

| Field | Value / rule | What it is |
|---|---|---|
| `id` | `agentNode_` + **12** `A–Za–z0–9` | id; the `agentNode_` prefix carries the kind |
| `type` | `"agentNode"` | mandatory node kind |
| `settings.agentId` / `agentName` | interpolated, **required** | identity |
| `settings.sessionId` / `requestId` | interpolated overrides (usually `""`) | route to a chat slot |
| `settings.llm` | company / model / modelId / parameters | literal model config |
| `settings.specialRules` | `[]` or the two `skip-…` rules | literal behaviour flags |
| `settings.prompts` | authored turns (role + content) | the scripted conversation (content interpolated) |
| `data.labelNode` | **fixed** `"LLM"` | card title |
| `data.descriptionNode` | **fixed** `"Use LLM processor"` | card subtitle |
| `data.open` / `openLLM` / `openPrompt` | which of the 3 panels is open | UI state |
| `dragHandle` | `".drag-handle__custom"` | fixed |

### Wiring (edges)

**In** from upstream; **Out** (`next_1`) for the answer; **Fallback** (`error`) for a provider failure.
Edges carry `"type": "step"` + `{ id, source, sourceHandle, target, targetHandle }`.

## ⚠️ Watch out for

- **`agentId` / `agentName` are required** — empty (or a placeholder that resolves empty) → `E6101`.
- **Leave Session/Request ID blank** unless you deliberately need a custom chat slot.
- **The tool catalogue + `<SYSTEM CALL>` instruction are yours to author** in the System prompt — the
  engine doesn't add them.
- **Fallback = a provider failure or a broken node configuration** (`E6101` / `E6002`), and only if wired
  — a bad `<SYSTEM CALL>` re-loops the agent, and an empty/refusal answer is a normal `Out`.
- **"Use tools" OFF disables tool calls**; **"Interact with DB" OFF** makes the turn stateless (no history).

## ⏱ Performance

Dominated by the model call (latency + tokens). A tool loop multiplies that by the number of tool rounds,
so keep tools purposeful and prompts tight. Max Tokens caps the answer size.

---

*Tool calling in depth: `../tool-calling.md`. Next node: Parallel Flows (`parallel-flows-node.md`).*
