# Building tools — worked examples of both kinds

> For the reasoning, the full return/session contract, and when to choose each kind, see `creating-tools.md`.

A tool is something an agent can **call** mid-answer (via a `<SYSTEM CALL>` block — see `tool-calling.md`).
There are **two kinds**, and this page builds one of each, end to end.

| Kind | `type` | `entry` is… | The implementation is… |
|---|---|---|---|
| **Script tool** | `"script"` | a path **under `tools/`** (e.g. `tools/weather.js`) | a JS file in `src/scripts/tools/` |
| **Flow tool** | `"flow"` | a **`File-Label`** (e.g. `Weather-Start`) | a whole `.flow` in `src/flows/` |

Both kinds share the **same three steps**:

1. **Register** the tool in `src/keen-tools.json` (`{ name, type, entry }`).
2. **Teach** the agent about it — write the `<SYSTEM CALL>` instruction + the tool catalogue into the
   agent's **System** prompt (the engine does not generate these — see `tool-calling.md` §5).
3. **Implement** it — a script (kind 1) or a flow (kind 2) — and make it **push its result back** to the
   agent so the tool loop continues.

> Reminder from `tool-calling.md`: the tool's reply travels through the **conversation**. A tool must end
> by pushing a user-role message to the calling agent — stamped with the agent's session and a fresh id:
> `Agent.setRootAgentPrompt(agentId, { prompt, sessionID: toolOptions.agentNode.flowContext.sessionId, requestID: Tools.generateUUID() })`
> — or the agent gets *"No tool response"*. This holds in a **flow** tool's Script nodes exactly as in a
> script tool.

---

## Example A — a **script tool** (`Weather Lookup`)

A tool that takes a city + day count and returns a forecast, implemented as a script.

### 1. Register it — `src/keen-tools.json`

```json
{
  "tools": [
    { "name": "Weather Lookup", "type": "script", "entry": "tools/weather.js" }
  ]
}
```

- `name` — **exactly** what the model will put in `!*tool`.
- `type: "script"` — runs as a script tool.
- `entry: "tools/weather.js"` — the file **must** live under `src/scripts/tools/` (the path starts with
  `tools/`; `..` is forbidden).

### 2. Teach the agent — in its **System** prompt (Prompt Settings → System)

```md
When you need a tool, output it between <SYSTEM CALL> and </SYSTEM CALL> markers, like this:

<SYSTEM CALL>
!*action
use tool
!*tool
Weather Lookup
!*context
{"city": "Sofia", "days": 3}
</SYSTEM CALL>

Rules: put the markers and each !* marker at the start of the line; nothing else inside the block.

### 1. Weather Lookup

- **Description**: Returns a short weather forecast for a city.
- **Usage**: Emit a SYSTEM CALL with `!*tool` = `Weather Lookup` and `!*context` = a JSON object
  `{"city": <string>, "days": <number 1-7>}`.
```

### 3. Implement it — `src/scripts/tools/weather.js`

```js
import Agent from 'system/agent';
import Http from 'system/http';
import Tools from 'system/tools';

export const exec = async () => {
    const tc      = toolOptions.toolContext;                       // the parsed SYSTEM CALL bundle
    const agentId = tc.agentId;                                    // who to reply to
    const session = toolOptions.agentNode.flowContext.sessionId;   // the agent's session (REQUIRED — see below)
    const raw     = (tc.options.context ?? '').trim();

    // One helper that ALWAYS stamps the reply with the agent's session + a fresh id.
    const reply = (text) =>
        Agent.setRootAgentPrompt(agentId, { prompt: text, sessionID: session, requestID: Tools.generateUUID() });

    // Validate the input the model sent; if it's wrong, tell it what to fix (self-correcting tool).
    let input;
    try { input = JSON.parse(raw); } catch { input = null; }
    if (!input || typeof input.city !== 'string' || typeof input.days !== 'number') {
        reply('Weather Lookup input invalid. Send !*context as {"city": <string>, "days": <number 1-7>}. ' +
              'You sent: ' + (raw || '(empty)'));
        return { ok: false };
    }

    try {
        const r = await Http.getJson(
            `https://api.example.com/forecast?city=${encodeURIComponent(input.city)}&days=${input.days}`);
        reply(r.ok ? `Forecast for ${input.city} (${input.days}d): ${JSON.stringify(r.body)}`
                   : `Weather service error (${r.status}).`);
        return { ok: r.ok };
    } catch (e) {
        reply(`Weather lookup failed: ${e.message}`);
        return { ok: false };
    }
};
```

That's a complete script tool: it reads the call from `toolOptions.toolContext`, validates, calls an API,
and **pushes the result back** — so the agent reads it and finishes its answer. (See `nodes/script-node.md`
for the `system/*` APIs and the try/catch reasoning.)

> ⚠️ **Always stamp the reply with `sessionID: toolOptions.agentNode.flowContext.sessionId`** (as the
> `reply` helper does). The agent resolves its trigger **scoped to its own session** — a reply pushed
> **without** the right `sessionID` is invisible to the re-invoked agent, which then reports **"No tool
> response"** *even though the tool ran and fetched data*. This is the #1 tool bug. The agent's session is
> on **`toolOptions.agentNode`** — **not** on the bare `flowContext` global (for a script tool that's the
> tool's own fresh session). See `tool-calling.md` §4.

---

## Example B — a **flow tool** (`Escalate`)

A tool that runs a **whole flow** (useful when the tool's work is itself a multi-node pipeline — call
agents, branch, loop). Here: create a support ticket, then report back.

### 1. Register it — `src/keen-tools.json`

```json
{
  "tools": [
    { "name": "Weather Lookup", "type": "script", "entry": "tools/weather.js" },
    { "name": "Escalate",       "type": "flow",   "entry": "Escalate-Start" }
  ]
}
```

- `type: "flow"` — runs as a flow tool.
- `entry: "Escalate-Start"` — a **`File-Label`**: it runs the Start node labelled `Start` in the file
  `Escalate.flow`. (It must resolve to a real entry, exactly like a Run/Jump target.)

### 2. Teach the agent — add to the System prompt catalogue

```md
### 2. Escalate

- **Description**: Opens a human support ticket for the user's issue.
- **Usage**: Emit a SYSTEM CALL with `!*tool` = `Escalate` and `!*context` = a short summary of the issue.
```

The `<SYSTEM CALL>` shape is identical — only `!*tool` differs:

```
<SYSTEM CALL>
!*action
use tool flow
!*tool
Escalate
!*context
Customer can't reset their password; reset email never arrives.
</SYSTEM CALL>
```

### 3. Implement it — `src/flows/Escalate.flow`

Build a flow starting at a Start node labelled **`Start`** (so its entry is `Escalate-Start`). A minimal
shape:

```
Start ─▶ Script (createTicket.js) ─▶ End
```

The Script node (`scripts/createTicket.js`) does the work and **pushes the result back to the calling
agent** — inside a flow tool, the calling agent's id arrives on `toolOptions.toolContext.agentId` and its
session on `toolOptions.agentNode.flowContext.sessionId`, exactly as in a script tool — and the reply
**must** be stamped with that session + a fresh `requestID` (a push without them is invisible to the agent
→ *"No tool response"*):

```js
import Agent from 'system/agent';
import Http  from 'system/http';
import Tools from 'system/tools';

export const exec = async () => {
    const tc      = toolOptions.toolContext;
    const agentId = tc.agentId;
    const session = toolOptions.agentNode.flowContext.sessionId;   // the calling agent's session (REQUIRED)
    const summary = (tc.options.context ?? '').trim();
    const reply   = (text) =>
        Agent.setRootAgentPrompt(agentId, { prompt: text, sessionID: session, requestID: Tools.generateUUID() });

    if (!summary) {
        reply('Escalate needs a non-empty !*context (the issue summary).');
        return { ok: false };
    }

    let r;
    try {
        r = await Http.postJson('https://desk.example.com/tickets', { summary });
    } catch (e) {
        reply(`Could not reach the ticket desk: ${e.message}`);   // a throw here would discard the queued reply
        return { ok: false };
    }
    reply(r.ok ? `Ticket ${r.body.id} created for the user.` : `Could not create a ticket (${r.status}).`);
    return { ok: r.ok };
};
```

Because it's a **flow**, you can make the tool as rich as you like — add a Condition to route by severity,
an Agent node to draft the ticket text, a Loop over attachments — anything a flow can do. The one rule is
the same: **end by pushing a message back to `toolOptions.toolContext.agentId`, stamped with
`toolOptions.agentNode.flowContext.sessionId` + a fresh `requestID`.**

---

## Example C — a **flow tool with a nested agent** (advanced)

The most powerful pattern: a **flow tool** whose flow contains its **own Agent node**, and that inner
agent **calls another tool**. When the inner agent finishes, the flow tool **returns its answer to the
outer (calling) agent**. This is a **nested tool loop** — the deepest thing you can build — and it has a
few sharp edges. Read `tool-calling.md` first.

```
Main agent (M) ──SYSTEM CALL──▶ flow tool "Assistant"
                                  Start ▶ Script(setup) ▶ Agent(inner A) ──SYSTEM CALL──▶ script tool
                                                          ◀── the script tool answers A
                                        ▶ Script(return) ▶ End
```

### There are THREE sessions in play — keep them straight

| Session | Belongs to | A script gets it from |
|---|---|---|
| **M's session** | the **outer/main** agent that called the flow tool | `toolOptions.agentNode.flowContext.sessionId` (also `flowContext.parentSessionId`) — present on every node of the flow tool itself; see the note below on where it is **not** |
| **the flow tool's session** = **A's session** | the flow tool run itself, and its inner agent A | the bare global **`flowContext.sessionId`** |
| the inner tool's session | the script tool A calls (weather/country/…) | that tool reads its own `toolOptions.agentNode…` = **A** |

So: the inner script tool answers **A** exactly like Example A (nothing new there — it uses *its*
`toolOptions.agentNode.flowContext.sessionId`, which is A). The new work is the flow tool's **two Script
nodes** — one to set up, one to return.

### ⚠️ Where M's identity lives — and the defensive stash

Inside the flow tool, `toolOptions` points to **M** on **every** node of the flow tool — not just the first.
How it gets there: the flow-engine copies an inbound `options` pack onto every same-flow continuation it
emits, and the reference clients (test harness, entanglement, agent-runner) re-seed **every** nodeTask of
a `toolFlow` bundle from the bundle's `flow.options` when the task carries none. A's own tool loop does
**not** disturb this: the `{ toolResponse, promptMarker }` options ride only on A's re-dispatch to itself
(an LLM node), and A's final-text continuation arrives without options — so the client seeds the M pack
back onto the return Script.

Where the pack is **absent**: inside a **Run Flow / Parallel** sub-flow spawned from within the tool flow
(spawned bundles are separate flows and don't inherit `options`), and with a **custom client** that does
not re-seed. **The defensive pattern therefore stays: stash M's identity into the dictionary at the first
node** and read it back at the return node — the dictionary is shared across the whole flow tool and its
Run Flow children, so it covers both cases. (This is why the setup Script exists.)

### 1. `scripts/setup.js` — stash M + seed the inner agent's trigger

```js
import Agent from 'system/agent';
import Tools from 'system/tools';

export const exec = () => {
    // (a) Stash the OUTER agent (M) — the defensive bridge (see the note above).
    dictionary.mainAgentId = toolOptions.toolContext.agentId;
    dictionary.mainSession = toolOptions.agentNode.flowContext.sessionId;

    // (b) Give the INNER agent A something to answer. A reads its trigger from ITS session,
    //     which is THIS flow's session = the bare global flowContext.sessionId.
    //     Without a user trigger the inner agent has no user message → E6002 on Anthropic/Google
    //     models (an OpenAI model would answer from its system prompt alone instead).
    Agent.setRootAgentPrompt('country-agent', {
        prompt: toolOptions.toolContext.options.context,   // e.g. {"country":"Bulgaria"} the main agent sent
        sessionID: flowContext.sessionId,                  // the flow tool's / inner agent's session
        requestID: Tools.generateUUID()
    });
    return { seeded: true };
};
```

> Two different sessions in one file — this is the crux: **M's** session (captured for the *return*) vs
> **the flow tool's** session (used to *trigger the inner agent*). Don't mix them up.

### 2. The inner agent node (`country-agent`)

A normal **Agent node** on the flow tool's canvas — its own `agentId` (distinct from M), its own `llm`,
and a **System prompt** that teaches it the inner script tool (`Country Lookup`, the `<SYSTEM CALL>`
format, the JSON `!*context`) exactly as in Example A/`tool-calling.md` §5. When it runs it calls the
script tool, reads the data back (the script tool answers **A**), and writes a friendly final answer.

### 3. `scripts/return.js` — hand A's answer back to M

```js
import Agent from 'system/agent';
import Tools from 'system/tools';

export const exec = () => {
    // Read the inner agent's final answer (newest response for that agent).
    const answer = Agent.getAgentLastResponse('country-agent')?.response ?? 'No answer was produced.';

    // Push it to the MAIN agent — using the identity we stashed at the first node.
    Agent.setRootAgentPrompt(dictionary.mainAgentId, {
        prompt: answer,
        sessionID: dictionary.mainSession,       // ← M's session (from the dict, NOT toolOptions here)
        requestID: Tools.generateUUID()
    });
    return { done: true };
};
```

Because the return step reads M's `agentId` + session **from the dictionary** (not `toolOptions`), it
works even where `toolOptions` is absent (a Run Flow sub-flow, a client that doesn't re-seed) — that's
the whole point of stashing it early.

### 4. Register the flow tool

```json
{
  "tools": [
    { "name": "Country Lookup", "type": "script", "entry": "tools/country.js" },
    { "name": "Assistant",      "type": "flow",   "entry": "Assistant-Start" }
  ]
}
```

- `Country Lookup` is the inner **script tool** A calls.
- `Assistant` is the **flow tool** M calls — `entry` is the flow's `File-Label` (`Assistant.flow`, start
  node `Start`).
- M's System prompt teaches M about **`Assistant`**; A's System prompt (inside the flow) teaches A about
  **`Country Lookup`**. Each agent only needs to know the tool *it* calls.

### Ordering — why the return Script runs after A is done

Wire it `Start → setup → country-agent → return → End`. The inner Agent node does **not** emit its `next_1`
(to the return Script) until it produces a **final plain-text answer** — i.e. after its whole tool loop
(the Country Lookup round-trip) has finished. So by the time `return.js` runs, A's answer is complete and
`getAgentLastResponse('country-agent')` returns it. The wiring guarantees the ordering.

### Is the return to the outer agent race-safe? (yes — client contract)

A natural worry: the outer agent's tool-response re-dispatch might fire **before** `return.js` pushes its
result, giving a spurious "No tool response." It doesn't — **the client that drives the loop keeps the
tool-calling node pending until every child flow drains (recursively), then fires the parent's
continuation.** So the outer agent only re-runs after the flow tool reached its End (after `return.js`
pushed). The reference clients (test harness + entanglement) both do this.

> ⚠️ This is a **client contract, not an engine guarantee** (the engine is a pure function; the client
> drives the loop). A custom client that fires the parent continuation early — without waiting for the
> child flows to drain — **would** race and get intermittent "No tool response" on slow tools. Any client
> must keep the spawning node pending until all children (recursively) complete. (See `gotchas.md` A13.)

### You now have more than one **LLM node** — keep them straight

A nested flow tool means **at least two LLM (Agent) nodes are running**: the **outer/main agent (M)** whose
LLM node called the flow tool, and the **inner agent (A)** — a second **LLM node** inside the flow tool
(and A itself may call further LLM nodes). Each **LLM node** is an independent agent with its **own
`agentId`, its own session, and its own conversation**. The rules that follow:

- **Distinct `agentId`s** — A must not share M's id, or their conversations collide.
- **Each reply goes to the right agent, stamped with THAT agent's session:** the inner script tool replies
  to **A** (using A's session = its own `toolOptions.agentNode…sessionId`); the flow tool's return step
  replies to **M** (using M's session, captured in the dict). Cross them and you get "No tool response".
- **Each agent needs its own System prompt** — M's teaches the flow tool; A's teaches the inner script
  tool. An agent only knows the tools *its* prompt describes.
- **Each agent reads its own trigger** — seed A's trigger explicitly (M's arrived automatically at run
  start; A's does not).

### ⚠️ Wire Error + Fallback here too (a nested tool has more failure points)

With multiple agents and multiple scripts, there are more ways to fail — **wire the failure edges** so the
outer agent always gets a clean answer instead of a silent "No tool response":

- **The inner Agent's Fallback (`error`)** → a `returnFailure` Script. If A's provider call fails
  (rate-limit, timeout, …) and Fallback is unwired, the flow continues with the error text as A's
  "answer," and `return.js` forwards that error string to M as if it were a real result (a garbled
  success). Wire Fallback → return a clean `{ ok:false, error:"the assistant failed" }` to M.
- **Each Script's Error (`error`)** (setup / return / returnFailure) → the same `returnFailure` Script.
  Even with internal try/catch, an unexpected throw ends the branch → M gets "No tool response" with no
  explanation.
- `returnFailure` reads M's identity from the dict (`dictionary.mainAgentId` / `dictionary.mainSession`,
  captured at node 1) and pushes a clean failure to M. (See "Wire the failure paths" below.)

### ⚠️ Watch out for (nested tools) — quick list

- **Capture M's identity at node 1** into the dictionary; don't rely *only* on `toolOptions` at the return
  node (it is there with the reference clients, but not inside a Run Flow / Parallel sub-flow, nor with a
  client that doesn't re-seed).
- **Seed the inner agent's trigger** with `sessionID: flowContext.sessionId` — or it errors (E6002 on
  Anthropic/Google; an OpenAI model just answers from its system prompt). This is the *flow tool's*
  session, not M's.
- **Return to M** with `sessionID: dictionary.mainSession` (M's session) — or M reports "No tool response".
- **Distinct agentIds + a System prompt per agent** (see above).
- **Wire the inner Agent's Fallback and every Script's Error** to a `returnFailure` step (see above, and
  "Wire the failure paths" below).

---

## Wire the failure paths (don't trust the happy path)

A tool must **always return something meaningful to its caller** — a clean success *or* a clean failure —
never dead-end and never let an error masquerade as a real answer. The two edges that make this happen are
easy to forget:

- **The inner Agent node's Fallback (`error`)** — fires on a provider failure (rate-limit, timeout,
  auth, 4xx/5xx), and also on a configuration or payload error caught before the call — missing
  llm/agentId, unknown model (`E6101`), no user message (`E6002`). **If you leave it unwired, the flow
  continues on `next_1` with the error text as the agent's "answer"** — and your return step will forward
  that error string as if it were a real result (a *garbled success*). Wire **Fallback → a small return-failure Script** that
  pushes a clean `{ ok:false, error:"the assistant failed" }` to the calling agent (with the caller's
  `sessionID`, from the dict — same as the normal return).
- **Each Script node's Error (`error`)** — fires when the script throws. Even if your scripts try/catch
  internally, wire the Error edge as a safety net → a return-failure Script — otherwise an unexpected
  throw ends the branch and the caller gets "No tool response" with no explanation.

A robust flow tool therefore has **three** exits that all reach the caller:

```
Start → setup → [Condition] → Agent(inner) ──next_1──▶ return(success) ──▶ End
                                    │ Fallback (error) ─▶ returnFailure ──▶ End
                setup / return / returnFailure  ── each node's Error (error) ─▶ returnFailure ─▶ End
```

The rule of thumb: **for every node that can fail (an Agent, any Script), ask "where does the caller's
answer come from if this fails?" — and wire that path.** A tool that only handles success is a tool that
silently breaks in production, where there is no debugger to tell you why.

## Which kind should I build?

- **Script tool** — the work is basically **one function**: call an API, transform data, compute
  something. Simplest; lives in `scripts/tools/`. (Example A.)
- **Flow tool** — the work is a **process**: multiple steps, branching, its own agent calls, a loop. Build
  it as a flow so you can use every node. (Example B.)

Either way: **register in `keen-tools.json`, teach the agent in the System prompt, push the result back**,
and **re-deploy** (the registry is compiled at deploy — see `tool-calling.md` §3). Make tools
**self-correcting** (validate the `!*context`, reply with what's missing) so an imperfect model call
recovers instead of failing.

---

*Protocol + loop mechanics: `tool-calling.md`. The Agent node: `nodes/agent-node.md`. Scripts & the
`system/*` APIs: `nodes/script-node.md`. Project layout: `extension/project-and-files.md`.*
