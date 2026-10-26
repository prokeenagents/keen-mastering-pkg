# Tool calling — the `<SYSTEM CALL>` protocol & the tool loop

> For the reasoning, the full return/session contract, and when to choose each kind, see `creating-tools.md`.

This is the heart of how an **Agent (LLM) node** does more than talk: it can **call a tool** (a flow or a
script), get the result, and keep going. This page is the exact, engine-verified reference. Read it with
`nodes/agent-node.md`.

Two halves fit together:

- **What the model emits** — a `<SYSTEM CALL>` block in its answer (the engine parses this).
- **What you author** — a **system prompt** that teaches the model which tools exist and how to emit that
  block (the engine does **not** generate this — you write it).

---

## 1. The `<SYSTEM CALL>` block (what the model emits)

When the agent wants a tool, it writes a block like this **inside its normal answer text**:

```
<SYSTEM CALL>
!*action
use tool flow
!*tool
Simple Tool
!*context
any free-form context the model wants to pass to the tool
</SYSTEM CALL>
```

### The grammar (exactly what the engine parses)

- The block is delimited by the literal markers **`<SYSTEM CALL>`** … **`</SYSTEM CALL>`** (uppercase,
  one space). Both must be present, closer after opener.
- Fields inside are **`!*<key>`** on their own, followed by the value (everything up to the next `!*key`
  or the end of the block). Values are trimmed. **The key must be followed by whitespace** (a newline or a
  space) — `!*tool:` / `!*tool=` is **not** a field: a block written that way parses to **nothing**, and the
  agent is re-called with *"Could not parse the SYSTEM CALL block."* (see §2).
- The three conventional fields:
  - **`!*action`** — a human-readable label of intent (e.g. `use tool` / `use tool flow`). **The engine
    does not branch on it** — it's informational and forwarded to the tool as context. (So `use tool
    flow` vs `use tool script` makes no difference to routing; see §3.)
  - **`!*tool`** — **the tool's NAME.** This is the one field routing depends on: the engine looks this
    name up in the project's tool registry (§3).
  - **`!*context`** — free-form text handed to the tool. Any **other** `!*key` you invent is also captured
    and passed along.

### Engine facts worth knowing

- The block may appear **inline** — the model can write a sentence before it and after it; only the block
  itself is the call.
- If the model emits **several** blocks, **only the first is executed.** Author prompts so the model emits
  **one** call at a time.
- A half-written block (opener, no closer — e.g. truncated) is treated as **plain text**, not a call.
- **Markers/fields are not strictly required at line-start by the parser** — but you should still author
  them at line-start (see §5), because it keeps the model consistent and readable.

---

## 2. What the tool loop does (step by step — the important part)

A tool call is **not** a function call inside one request. It's a **loop of turns**:

```
1. You send a message → the Agent runs the LLM.
2. The LLM answers WITH a <SYSTEM CALL> block  → the engine sees a tool call.
3. The engine runs the named tool (a flow or a script) as a sub-run.
4. The tool writes its result back as a NEW "user" message to the agent.
5. The Agent runs the LLM AGAIN, now seeing the tool's result as the latest user turn.
6. If the LLM answers with ANOTHER <SYSTEM CALL> → back to step 3.
   If the LLM answers with PLAIN TEXT (no block) → that's the final answer → out the Out dot.
```

So the loop keeps going **as long as the model keeps emitting `<SYSTEM CALL>` blocks**, and ends the
moment it answers with plain text. The tool's result comes back as a **user-role turn** (as if the user
had pasted the result), which is what the model reads on the next round.

### How many messages are in its history

Each agent turn is built from three parts (see `nodes/agent-node.md`):
- your **authored** prompts (system + any scripted turns),
- up to **50** prior turns from the chat history, **and**
- the **live** latest user message.

During a tool loop, the **current** exchange's tool turns are kept at **full fidelity** (so the model
sees every step it just took), while **past** exchanges' tool turns are dropped from history as plumbing
noise. Adjacent same-role turns are then merged (two `user` turns in a row become one). So the practical
ceiling on prior history is **~50 turns** (each expands to a user + an assistant message), plus the
current loop's own turns.

### If a tool call goes wrong

These do **not** take the Fallback edge — instead the engine feeds a short **user** message back and
re-runs the agent so it can recover:
- block can't be parsed (no `!*key` fields — e.g. the colon form `!*tool:`) → *"Could not parse the SYSTEM CALL block."*
- `!*tool` names a tool that isn't registered → *"The requested tool does not exist."*
- the tool ran but pushed **no** result → *"No tool response"*.
- **two silent cases that also say *"No tool response"* — the tool never runs and nothing is logged:** a
  registered **script** tool whose `entry` isn't under `tools/` (or contains `..`), and a **flow** tool whose
  `entry` doesn't resolve to a real start node. Deploy does **not** catch either — check the registry first.

(The **Fallback** edge is only for a real **LLM/provider failure** or a broken node configuration caught
before the call — see `nodes/agent-node.md`.)

---

## 3. How `!*tool` resolves — the tool registry

The name in `!*tool` is matched against the project's **tool registry** — each tool is
`{ name, type, entry }`:

- **`type: "flow"`** → `entry` is a **`File-Label`** flow entry; the engine runs that flow as the tool.
- **`type: "script"`** → `entry` is a **script path under `scripts/tools/`** (it must start with `tools/`);
  the script runs as the tool.

You declare these tools in **`keen-tools.json`** in your project (see the extension / project-structure
guide). **The `name` there is exactly what the model must put in `!*tool`.** Routing is decided by the
tool's **`type`**, not by the `!*action` text.

> At runtime the engine reads the registry from the **compiled** `flows/init.map.js` (produced from
> `keen-tools.json` at **deploy**), not from `keen-tools.json` directly. So if a tool is "not found" even
> though it's in `keen-tools.json`, the usual cause is that the project wasn't re-deployed — check that the
> upload succeeded.

> This is why there is a **`scripts/tools/`** folder: **script tools live there.** A script tool's `entry`
> is a path like `tools/lookup.js` (sub-folders such as `tools/billing/charge.js` are fine; `..` is not). The
> engine refuses any other path **at call time, silently** — the tool never runs and the agent just gets
> *"No tool response"*; deploy does not reject it.

---

## 4. Writing a **script tool** — receiving the call & returning the result

This is the detail that trips people up: a tool the LLM calls must both **receive** the call's context and
**push its result back into the conversation** — a tool that's registered but does neither runs and then
the agent reports *"No tool response"*.

**How a script tool receives the SYSTEM CALL — the `toolOptions` global.** Inside a tool script a bare
global **`toolOptions`** is present (only when the script runs as a tool). It has **two** parts:

| Field | What it is |
|---|---|
| `toolOptions.toolContext.options` | the **parsed `!*` fields**: `{ action, tool, context, …anyCustomKey }`. `…options.context` is the `!*context` text. |
| `toolOptions.toolContext.agentId` | the **agent to reply to** (the agent that made the call). |
| `toolOptions.toolContext.prompt` | the model's full message that contained the call (reference). |
| **`toolOptions.agentNode.flowContext.sessionId`** | **the calling agent's session** — you MUST stamp your reply with this (see the ⚠️ below). |

> **Note on `flowContext`:** a tool script *also* has a bare `flowContext` global. For a **script tool**
> its `sessionId` / `requestId` are the tool's **own fresh** ids — **not** the agent's. The agent *is* on it
> too: **`flowContext.parentSessionId`** is the calling agent's session (the same value as
> `toolOptions.agentNode.flowContext.sessionId`), `flowContext.parentFlowId` its flow and
> `flowContext.currentFlowId` its dictionary. Stamp replies with **`toolOptions.agentNode.flowContext.sessionId`**
> (or, equivalently, `flowContext.parentSessionId`) — never with the bare `flowContext.sessionId`.

**How it returns the result** — the tool does **not** "return" into the model by its `return` value. It
**pushes a new user message** to the calling agent, which the next LLM round reads:

```js
import Agent from 'system/agent';
import Http from 'system/http';
import Tools from 'system/tools';

export const exec = async (props) => {
    const tc      = toolOptions.toolContext;                       // the parsed SYSTEM CALL bundle
    const query   = tc.options.context;                           // the !*context the LLM sent
    const agentId = tc.agentId;                                   // who to answer
    const session = toolOptions.agentNode.flowContext.sessionId;  // the agent's session (REQUIRED)

    let result;
    try {
        const r = await Http.getJson(`https://api.example.com/lookup?q=${encodeURIComponent(query)}`);
        result = r.ok ? JSON.stringify(r.body) : `lookup failed (${r.status})`;
    } catch (e) {
        result = `lookup error: ${e.message}`;
    }

    // THIS is what makes the tool "work": push the result back to the agent,
    // stamped with the agent's session + a fresh requestID.
    Agent.setRootAgentPrompt(agentId, { prompt: result, sessionID: session, requestID: Tools.generateUUID() });
    return { done: true };
};
```

> ⚠️ **You MUST stamp the pushed prompt with `sessionID: toolOptions.agentNode.flowContext.sessionId`.**
> The agent resolves its trigger **scoped to its own session** — a prompt pushed **without** the right
> `sessionID` is **invisible** to the re-invoked agent, which then reports **"No tool response"** *even
> though the tool ran and pushed data*. This is the #1 tool bug. A fresh `requestID` (via
> `Tools.generateUUID()`) mirrors the engine's own recall and is best practice. Without the push at all,
> you also get "No tool response". A **flow tool** likewise must end by writing its answer where the
agent reads it (the same conversation). (See `business-objects.md` — results travel through the
conversation, not along the wire; and `nodes/script-node.md` for the `system/agent` API.)

### Self-correcting tools — send back "what's missing" and let the agent retry

Because the tool's reply comes back as a **new user message the agent re-reads**, you can make a tool
**validate its inputs and, on a problem, reply with what's wrong** instead of failing. The agent reads that
message, fixes its `<SYSTEM CALL>`, and **calls the tool again** — a natural retry loop, no error edge, no
crash.

Build the tool to check the `!*context` it received and, if it's missing or malformed, **push a corrective
message back**:

```js
import Agent from 'system/agent';
import Tools from 'system/tools';

export const exec = (props) => {
    const tc      = toolOptions.toolContext;
    const agentId = tc.agentId;
    const session = toolOptions.agentNode.flowContext.sessionId;   // REQUIRED — see §4
    const raw     = (tc.options.context ?? '').trim();
    const reply   = (t) => Agent.setRootAgentPrompt(agentId, { prompt: t, sessionID: session, requestID: Tools.generateUUID() });

    // Expect context = a JSON object like {"city":"...","days":3}
    let input;
    try { input = JSON.parse(raw); }
    catch { input = null; }

    if (!input || typeof input.city !== 'string' || typeof input.days !== 'number') {
        // Tell the agent exactly what's wrong — it will re-read this and call again.
        reply('Tool input invalid. Send !*context as JSON: {"city": <string>, "days": <number>}. ' +
              'You sent: ' + (raw || '(empty)'));
        return { ok: false };
    }

    // …inputs are valid — do the work and push the real result…
    reply(`Weather for ${input.city} over ${input.days} days: …`);
    return { ok: true };
};
```

Now the conversation self-heals: the model calls the tool with a bad payload → the tool answers *"send it
as JSON with `city` and `days`"* → the model re-emits a correct `<SYSTEM CALL>` → the tool runs for real.
This is the recommended way to make tools **robust to imperfect model output** — a clear "what's
missing/expected" message is far better than a silent failure, because the agent can act on it. (Keep the
message specific: name the missing field and the expected format, as above.)

---

## 5. What you author — teaching the model about tools (the system prompt)

**The engine does not generate a tool list or any instructions.** It only parses the block the model
emits. So you must **author**, into the agent's **System** prompt (Prompt Settings → System), both:

1. **the instruction** that teaches the `<SYSTEM CALL>` format, and
2. **the catalogue** of available tools.

These are **conventions** (Markdown text you write) — the engine doesn't enforce them, but the model needs
them to know what to emit. A proven template:

**The instruction** (author verbatim into the System prompt):

```md
You will be given a tool to use for retrieving simple information.

When you need to use the tool, please output it between <SYSTEM CALL> and </SYSTEM CALL> markers.
Use the following format:

<SYSTEM CALL>
!*action
use tool flow
!*tool
Simple Tool
!*context
</SYSTEM CALL>

Important:
- Place <SYSTEM CALL> and </SYSTEM CALL> at the start of the line.
- Each !* marker must be at the start of the line.
- The content for each parameter can include any text, including special characters.
- Do not indent the markers.
- Do not include any extra text inside the <SYSTEM CALL> block.
- Outside the <SYSTEM CALL> block, you can provide explanations or continue the conversation as needed.
```

**The tool catalogue** — one entry per tool, in **Markdown** (the values are MD):

```md
[TOOL_NUMBER]. [TOOL_NAME]

Description: [TOOL_DESCRIPTION]

Usage: [TOOL_USAGE]
```

- **`[TOOL_NAME]`** must be **exactly** the tool's `name` from `keen-tools.json` — that's what the model
  will put in `!*tool`, and what the engine resolves against the registry.
- **`[TOOL_DESCRIPTION]`** / **`[TOOL_USAGE]`** are **Markdown** free text you write to tell the model what
  the tool does and when/how to use it. (The engine stores no description/usage of its own — this text is
  the model's only guide.)
- **`[TOOL_NUMBER]`** is just an index to keep the list readable.

Because the whole System prompt supports `${dictionary.*}` / `${session.*}` placeholders, you can even
build parts of the catalogue dynamically. (One caveat: `${session.*}` resolves in an Agent node only when
that agent runs on the run's root session — inside a Parallel Context clone it comes back empty; put such
values in the dictionary. See `business-objects.md`.)

---

## Corrections vs. common assumptions (all engine-verified)

- **`!*action` doesn't route** — the tool's `type` (flow/script) in the registry decides script vs flow.
- **No auto-generated tool list** — the catalogue + the `<SYSTEM CALL>` instruction are **author-written**
  into the System prompt; the engine only parses the block and resolves the name.
- **Only the first `<SYSTEM CALL>` block runs** per answer.
- **Tool-call errors re-loop the agent** (a `<SYSTEM CALL>` that won't parse, an unknown tool, no tool reply — with a synthetic user message); they do **not** take Fallback.

---

*Full worked examples of building a tool of each kind (script + flow): `building-tools.md`. Back to the
node: `nodes/agent-node.md`. Project layout for `keen-tools.json` + `scripts/tools/`: see the extension /
project-structure guide.*
