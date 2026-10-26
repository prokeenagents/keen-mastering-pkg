# Creating tools — the reasoning, the return contract, and when to use each kind

A field guide to Keen tools: how an agent **does** something instead of only talking — the protocol, the
two kinds of tool, and the one contract you must keep so the answer actually gets back to the agent.

Written after building **11 working tools** — ten script tools and one flow tool with a nested agent and a
parallel fan-out. Every claim here is either **verified in a trace** or explicitly flagged as unverified.

This is the **why**-focused companion to the two reference pages:

- `tool-calling.md` — the `<SYSTEM CALL>` protocol and the tool loop, at reference level.
- `building-tools.md` — worked examples of a script tool and a flow tool, end to end.

Read those for the *shape* of things. Read this for the *reasoning*, the full return/session contract, and
the decision of **which kind** to build.

**Contents**

- [00 · What a tool actually is](#00--what-a-tool-actually-is)
- [01 · The cycle of one call](#01--the-cycle-of-one-call)
- [02 · The `<SYSTEM CALL>` protocol](#02--the-system-call-protocol)
- [03 · The three parts you write](#03--the-three-parts-you-write)
- [04 · Script tool or flow tool](#04--script-tool-or-flow-tool)
- [05 · How the answer gets back — the return contract](#05--how-the-answer-gets-back--the-return-contract)
- [06 · The map of sessions](#06--the-map-of-sessions)
- [07 · Self-correcting tools](#07--self-correcting-tools)
- [08 · The paths of failure](#08--the-paths-of-failure)
- [09 · Practices from the battlefield](#09--practices-from-the-battlefield)
- [10 · Which approach, when](#10--which-approach-when)
- [11 · Checklist & symptoms](#11--checklist--symptoms)

---

## 00 · What a tool actually is

A language model can do exactly one thing: **produce text.** It can't open a connection, read a database,
or look at the clock. Everything it knows was in its prompt.

A **tool** is the mechanism by which an agent escapes that limit — and it works the only way it possibly
can: the model writes something that is **not meant for the human but for the engine.** The engine
recognises it, runs some code of yours, and puts the result back into the conversation **as a new message.**
The model is then started again, and now it sees the data as though the user had handed it over.

That last part is the key to everything else in this document. There is **no "return of a value"** to the
model. There is only a conversation in which someone added a line.

> A tool is **not a function** the agent calls and waits on. A tool is a **conversation partner** the agent
> passes a note to, and who answers back with a new line **in the same conversation.** Every later
> confusion — *"why doesn't the agent see the result", "why doesn't `return` work"* — comes from someone
> having thought of it as a function.

### What the engine does, and what is left to you

The split is narrow and worth knowing by heart, because most lost time comes from expecting the engine to
do something it does not:

| The engine does | You do |
|---|---|
| Recognises the `<SYSTEM CALL>` block in the model's answer | Teach the model to emit it — with text in the system prompt |
| Looks up the name from `!*tool` in the registry and starts the tool | Register the tool in `keen-tools.json` |
| Starts the agent again after the tool finishes | Write the tool itself — and make sure it **speaks back** |
| Synthesizes a message on a bad block or a missing tool | Describe what each tool does and when it's used |

**The engine does not generate a tool catalogue.** It does not tell the model which tools exist, what they
do, or how they're called. The registry stores only `{ name, type, entry }` — **there is no description
field.** If you don't write the catalogue yourself in the system prompt, the agent will simply never call
anything.

---

## 01 · The cycle of one call

A call is not a step, it's a **cycle of rounds.** Each round is a fresh run of the model with a grown
conversation. The exact sequence:

```
1. You send a message      → the Agent runs the model.
2. The model answers WITH a <SYSTEM CALL> block → the engine sees a tool call.
3. The engine runs the named tool (a script or a flow) as a sub-run.
4. The tool writes its result back as a NEW user-role message to the agent.
5. The Agent runs the model AGAIN, now seeing the tool's result as the latest user turn.
6. Another <SYSTEM CALL>? → back to step 3.  Plain text? → that's the final answer, out.
```

The cycle runs **as long as the model keeps emitting blocks**, and ends the instant it answers with plain
text. That has two consequences you feel immediately:

- **Every tool costs a whole round of the model.** Three tools called means at least four runs of the LLM.
  Time and tokens grow linearly.
- **History grows.** Within the current exchange, the tools' turns are kept **whole**, so the model sees
  what it just did. From past exchanges they're dropped as noise. The practical ceiling on prior history is
  **~50 turns.**

### What this looks like in a real trace

From an actual run — one question, one tool, two rounds of the agent:

```
agent-runner · flow tree

▸ flow 3d87faaa — 4 node(s)          ← the main flow
    startNode
    agentNode  → <SYSTEM CALL> Current Weather {"city":"Sofia"}   454 in / 33 out
    agentNode  → "It's overcast in Sofia right now…"              615 in / 69 out
    endNode    → final: true

▸ flow 8c21e0b7 — 3 node(s)          ← the tool, a separate virtual flow (its own flowId)
    virtualStartNode
    virtualScriptNode  tools/weather.js  → returnValue {done: true}
    virtualEndNode
```

Notice two things. The **agent node appears twice in the same flow** — those are the two rounds. And the
**tool is a separate flow with its own `sessionId`.** That second detail is the reason the entire
[map of sessions](#06--the-map-of-sessions) exists.

---

## 02 · The `<SYSTEM CALL>` protocol

This is the only thing the engine reads out of the model's answer:

```
<SYSTEM CALL>
!*action
use tool
!*tool
Current Weather
!*context
{"city": "Sofia"}
</SYSTEM CALL>
```

### The grammar

| Element | Meaning |
|---|---|
| `<SYSTEM CALL>` … `</SYSTEM CALL>` | Exact markers, uppercase, one space. Both required. |
| `!*action` | A human label for the intent. Influences nothing. Passed to the tool as context and no more. |
| `!*tool` | **The only field routing depends on.** Looked up **literally** in the registry. |
| `!*context` | Free-form text for the tool. Any other `!*whatever` is also captured and passed along. |
| `!*key` + whitespace | A key must be followed by a newline or a space. `!*tool:` / `!*tool=` is **not** a field — the whole block parses to nothing → *"Could not parse the SYSTEM CALL block."* |

### Four behaviors you must know

- **The block may be embedded in text.** The model may write a sentence before and after it — only the
  block is the call. In practice the user also sees *"One moment, let me check…"*, which is pleasant.
- **Only the first block runs.** The engine parses all of them but runs `parsedCalls[0]`. So the prompt
  must say explicitly: **one call per round.**
- **An unclosed block is plain text.** An opener with no closer — because of a length cutoff, say — does
  not count as a call.
- **`!*action` does not route.** Whether the tool is a script or a flow is decided by the `type` field in
  the registry. You can write `use tool flow` for a script tool — nothing changes.

> If the model emits **two** blocks because the user asked two questions, the second one just disappears —
> no error, no warning. The agent will then behave as though it had called it. Write in the prompt: *"if you
> need a second tool, wait for the first result and call it on your next turn."*

---

## 03 · The three parts you write

Every tool, from the simplest to the most complex, is always the same three things. Miss one and nothing
works — usually silently.

### Part 1 — the registry

The file `src/keen-tools.json`. This is where you tell the engine what exists and how to start it:

```json
{
  "tools": [
    { "name": "Current Weather", "type": "script", "entry": "tools/weather.js" },
    { "name": "Multi Answer",    "type": "flow",   "entry": "MultiAnswer-Start" }
  ]
}
```

- **`name`** — exactly what the model will write in `!*tool`. The match is **literal**, with the spaces and
  the capital letters.
- **`type`** — `script` or `flow`. Decides how it's started.
- **`entry`** — for a script: a path **required to be under `tools/`** (the file lives in
  `src/scripts/tools/`). For a flow: a `File-Label` address, e.g. `MultiAnswer-Start` means the Start node
  labelled `Start` in the file `MultiAnswer.flow`.

> **A change to the registry requires a fresh deploy.** At runtime the engine reads the **compiled**
> `flows/init.map.js`, not the JSON file itself. If you get *"The requested tool does not exist"* even
> though the tool is in `keen-tools.json` — almost always the project wasn't uploaded again.

### Part 2 — the catalogue in the system prompt

This is where you write **what the tool does and when it's used.** The engine does not do this for you. The
minimal working catalogue is a format plus a list:

```md
## Using a tool

When you need a fact you don't have, write a block between
<SYSTEM CALL> and </SYSTEM CALL>, exactly like this:

<SYSTEM CALL>
!*action
use tool
!*tool
Current Weather
!*context
{"city": "Sofia"}
</SYSTEM CALL>

The markers and every !* begin on a new line, no indentation.
At most ONE block per turn — only the first is executed.

## Your tools

### 1. Current Weather
- Description: current weather for a city — temperature, feels-like, humidity, wind.
- Context: {"city": "Sofia"}
```

> Write the **when-to-use**, not just the shape of the context. With us, one worker got the question *"What
> time is it in New York?"* and called **Place Lookup** instead of **Current Time** — because its catalogue
> had only names and schemas, no descriptions. The fix was a single sentence: *"the name of a place says
> WHICH place — the question itself says WHAT is being asked about it."*

### Part 3 — the implementation itself

A script or a whole flow. Whatever it is, its one duty is: **to speak back to the agent.** That is what the
[return contract](#05--how-the-answer-gets-back--the-return-contract) is about — the most important thing
here.

---

## 04 · Script tool or flow tool

The two kinds look identical from the outside — the model emits the same block and does not know the
difference. Inside they are different things.

| | Script tool | Flow tool |
|---|---|---|
| `type` | `"script"` | `"flow"` |
| `entry` | `tools/weather.js` | `MultiAnswer-Start` |
| Lives in | `src/scripts/tools/` | `src/flows/` |
| The implementation is | one JS file with `exec` | a whole graph of nodes |
| Can it call an LLM | no | yes — with an Agent node inside |
| Can it branch | only with `if` in the code | Condition, Loop, parallel nodes |
| Return complexity | low — one session | high — up to three sessions |
| Debugging | script debugger, by line | flow debugger, by node |

### The real difference

It is not "simple vs complex." It's this:

**Script tool**

- The work is **one function**: call an API, transform data, compute something.
- The result is deterministic — same input, same output.
- No judgment needed, only execution.
- **One session** to think about. You answer one agent, with its session.

**Flow tool**

- The work is a **process**: several steps, branches, its own agents.
- Somewhere inside, judgment is needed — i.e. a **second LLM.**
- You want parallelism or a loop over a collection.
- **Three sessions** to track. The weight is real.

The practical rule: **start with a script tool.** Move to a flow tool only when you need a second model
inside the tool, or a structure that can't be expressed in one file. A flow tool is **not** a more powerful
version of a script tool — it's a different instrument with a noticeably higher maintenance cost.

> **A script tool can also drive agents.** It has access to `system/agent`, and it can read one agent's
> answer and hand it as a prompt to another. So *"I need a second agent"* is **not** automatically an
> argument for a flow tool. The argument is **structure**: branching, waiting, parallelism — things the
> graph expresses and a single file does not.

---

## 05 · How the answer gets back — the return contract

This is the heart of the whole document. If you remember only one section, let it be this one.

### First: `return` is not the answer

The natural reflex is this one — and it's wrong:

```js
// DOES NOT WORK — the value never reaches the model
export const exec = async () => {
    const data = await Http.getJson(url);
    return { weather: data };
};
```

The returned value only **ends the script's execution.** It is not handed to the LLM. If that's all you do,
the agent will report **"No tool response"** — even though the tool ran, called the API, and got the data.

The answer **travels through the conversation.** The tool pushes a new message with role **user** to the
agent that called it:

```js
import Agent from 'system/agent';
import Tools from 'system/tools';

export const exec = async () => {
    const tc = toolOptions.toolContext;

    Agent.setRootAgentPrompt(tc.agentId, {
        prompt: '<WEATHER_RESULT>\n' + JSON.stringify(result) + '\n</WEATHER_RESULT>',
        sessionID: toolOptions.agentNode.flowContext.sessionId,
        requestID: Tools.generateUUID()
    });

    return { done: true };   // only ends cleanly
};
```

### Second: the session stamp

> The agent looks for its prompt **within the scope of its own session.** A message pushed without the
> correct `sessionID` is written into agent state — but stays **invisible** to the re-started agent. It
> finds only the original question, and the engine synthesizes *"No tool response"*.

The tool ran. The data arrived. The logs prove it. And yet the agent says there's nothing there. This is the
most expensive hour you will lose if you don't know about it.

Three details, **any one** of which is enough to break it silently:

| Detail | Correct | Silent mistake |
|---|---|---|
| Capitals on write | `sessionID:` · `requestID:` | `sessionId:` — silently ignored |
| Lowercase on read | `flowContext.sessionId` | — |
| Where the session comes from | `toolOptions.agentNode.flowContext.sessionId` (= `flowContext.parentSessionId`) | `flowContext.sessionId` — that's the tool's own session |

> Yes — you **read** with a lowercase `d` and you **write** with a capital `D`. It looks like an oversight
> in the API, and it is exactly that, but it's the real contract. Write `sessionID:` / `requestID:`; read
> `flowContext.sessionId`.

### Third: a fresh `requestID`

Every pushed message gets a **new UUID** via `Tools.generateUUID()`. The sandbox has no `crypto` — this is
the allowed way. If you repeat the old `requestID`, the message looks like the same turn, not a new one.

### Fourth: a clean return

The writes to the agent **accumulate in the sandbox and are flushed only on a clean return.** If the script
throws an exception **after** `setRootAgentPrompt`, everything accumulated is **discarded** — and the agent
again gets nothing. So:

- wrap the risky work in `try/catch`;
- push a message on the **error path** too, not only on success;
- end with a plain `return { done: true }`.

> Make **one helper** at the top of the tool and never call `setRootAgentPrompt` anywhere else. Then it
> becomes impossible to miss the stamp in some rare branch:
>
> ```js
> const reply = (payload) => {
>     Agent.setRootAgentPrompt(agentId, {
>         prompt: '<TOOL_RESULT>\n' + JSON.stringify(payload) + '\n</TOOL_RESULT>',
>         sessionID: agentSessionId,
>         requestID: Tools.generateUUID()
>     });
>     return { done: true };
> };
> ```
>
> With us, this tool had **seven** exits — invalid input, city not found, two HTTP errors, two transport
> errors, one success. All of them go through `reply`.

### And for a flow tool?

The same rule, only some **node** in the flow has to do it — usually the last Script before End. The
difference is **where it takes the calling agent's identity from**, and that's the
[next section](#06--the-map-of-sessions).

---

## 06 · The map of sessions

For a simple script tool there are **two** sessions and they don't get confused easily. For a nested flow
tool there are **three**, and they will almost certainly get confused if you don't have the map.

| Whose session | Taken from | What it's for |
|---|---|---|
| The main agent (which called the flow tool) | `toolOptions.agentNode.flowContext.sessionId` — on every node of the flow tool itself (see below) | the final answer back to it |
| The flow tool itself = the nested agent | the bare global `flowContext.sessionId` | seeding a prompt on the nested agent |
| The inner script tool | its own `toolOptions.agentNode…` = the nested agent | answering the nested agent |

> **`toolOptions` does survive the nested tool cycle — with the reference clients.** The flow-engine copies
> an inbound `options` pack onto every same-flow continuation, and the test harness / entanglement /
> agent-runner clients re-seed every nodeTask of a `toolFlow` bundle from `flow.options` when it carries
> none. The `{ toolResponse, promptMarker }` options exist only on the inner agent's re-dispatch **to
> itself**; its final-text continuation arrives without options and gets the outer pack seeded back.

Where the pack is **absent**: a **Run Flow / Parallel** sub-flow spawned inside the tool flow (spawned
bundles don't inherit `options`), and a **custom client** that doesn't re-seed. There the script which
returns the answer would **no longer see who the caller was.**

So capture the identity anyway — it's a contract, not a workaround: **write it in the first node** into the
`dictionary`, which the whole tool flow and its Run Flow children share:

`setup.js` — the first Script node

```js
// Note: statement ORDER does not protect this. On a throw the WHOLE dictionary delta is
// discarded (bridge included), so this script must RETURN cleanly — validate, push the
// correction to the caller, return — and never throw after writing the bridge.
dictionary.bridge = {
    mainAgentId: toolOptions.toolContext.agentId,
    mainSession: toolOptions.agentNode.flowContext.sessionId
};
```

`returnToMain.js` — the last Script node

```js
const bridge = dictionary.bridge;      // NOT toolOptions

Agent.setRootAgentPrompt(bridge.mainAgentId, {
    prompt: '<RESULT>\n' + JSON.stringify(payload) + '\n</RESULT>',
    sessionID: bridge.mainSession,
    requestID: Tools.generateUUID()
});
```

### The nested agent has no prompt

An **Agent node** does not receive input along the edge. It reads the newest message with role **user** for
its `agentId`. For the main agent, the platform does that. For a nested agent — **nobody.** If you don't
seed it, it throws **E6002** (*"at least one user message"*) on Anthropic/Google models — and on an OpenAI
model it silently answers from its system prompt alone, which is worse:

```js
Agent.setRootAgentPrompt('inner-agent', {
    prompt: toolOptions.toolContext.options.context,
    sessionID: flowContext.sessionId,     // the flow tool's session, NOT the main one
    requestID: Tools.generateUUID()
});
```

Note: this is the **opposite** of the rule in the [return section](#05--how-the-answer-gets-back--the-return-contract).
There the bare `flowContext` was the mistake; here it is the correct choice — because now you are not
answering an external agent, you are **driving an internal one.** Two different sessions in one file.

> The Agent node has an option `agentResponse: true` + `agentResponseProperty: "answer"` that drops its
> answer **directly into the current `dictionary`.** Then you don't read agent state at all — zero
> cross-session reads, zero questions about channels.
>
> For the parallel fan-out this was the decisive simplification: five clones ran the same agent at once,
> each wrote into its own `dictionary`, and nobody touched anyone else's.

---

## 07 · Self-correcting tools

The model **will** get the format of `!*context` wrong. It'll send Cyrillic where it needs Latin; it'll miss
a field; it'll send text instead of JSON. This is not a defect to be fixed — it's a property to be **met.**

And because the tool's answer comes back as a new message the agent reads, you have something better than an
exception: **you can tell it what's wrong.**

Use the same envelope for all tools:

```js
// success
{ "ok": true, "temperatureC": 25.2, "conditions": "overcast" }

// the model got it wrong — it can correct and try again
{ "ok": false, "retryable": true,
  "error": "Current Weather input is invalid.",
  "correction": "Call again with !*context as JSON: {\"city\":\"Sofia\"}" }

// the source is down — no point retrying
{ "ok": false, "retryable": false,
  "error": "Weather service unavailable (503)." }
```

And in the prompt, once for all tools:

- `ok: true` — use the data, don't call the same tool again;
- `ok: false` + `retryable: true` — read `correction`, fix it, and try **once more**; if it still fails,
  explain to the user;
- `ok: false` + `retryable: false` — say the service is unavailable, and stop.

> Twice in one test day, without my prompting it: **Place Lookup** didn't find *"Стария град, Пловдив"* →
> returned `retryable` → the agent tried *"Старинен Пловдив"* and got the coordinates. And **Book Search**
> didn't find *"Дюн"* in Cyrillic → the agent tried *"Dune"* and found the three books.

> The **"at most one retry"** cap matters — without it the model can enter an infinite loop, and every round
> costs money.

Note the distinction: **call-level failures — an unrecognised block, a missing tool, a tool that pushed
nothing — do not go through the Fallback edge.** The engine simply feeds a short message back and re-runs
the agent so it can recover. **Fallback fires only on a real model-provider failure** — or on a broken
node configuration caught before the call (missing `agentId` / `llm`, an unknown model: `E6101`).

---

## 08 · The paths of failure

The happy path tests itself. Failure does not — and that is exactly where the platform is most silent.

### Unwired Fallback edge on an Agent node

If the call to the provider fails and the `error` edge is not wired, the flow continues along `next_1`, and
the error **text** is recorded as the agent's "answer." The next node that reads it hands it onward as
though it were a real result.

This is **worse than a clean failure.** It is a fake success: the calling agent receives the error text and
**relays it to the user as fact.**

### Unwired Error edge on a Script node

A thrown exception simply terminates that branch. The tool pushes nothing, the caller gets *"No tool
response"*, and there is no explanation at all of why.

### What a well-wired flow tool looks like

```
Start → setup → Agent(nested) ──next_1──▶ return(success) ──▶ End
                     │
                     └── error (Fallback) ─▶ returnFailure ──▶ End

setup / return / returnFailure — each node's error → returnFailure → End
```

`returnFailure` reads the identity from the `dictionary` bridge and pushes a **clean** failure to the
caller: `{ ok: false, error: "…" }`.

The rule worth turning into a habit: **for every node that can fail, ask "where does the caller's answer
come from if this node dies" — and wire that path.**

> Sometimes the best exit is **no branch at all.** With us the flow tool had to check the input and stop on
> an invalid one. Instead of a Condition node, the script simply leaves an **empty array** — and a Parallel
> Context over an empty collection passes straight to its exit. Fewer nodes, fewer edges, one branch fewer
> to wire and test.

---

## 09 · Practices from the battlefield

### HTTP 200 doesn't mean valid data

The most expensive lesson, and it repeated twice. Once with `restcountries.com/v3.1` — after a redirect it
returns HTTP 200 with a body of
`{"success": false, "errors": [{"message": "This API version has been deprecated…"}]}`. A second time with
geocoding: an unknown city returns 200 with **no `results` field.**

So check **both** the status **and** the shape:

```js
const r = await Http.getJson(url);
if (!r.ok) { /* HTTP error — does NOT throw, returns ok:false */ }
const hits = r.body && Array.isArray(r.body.results) ? r.body.results : [];
if (hits.length === 0) { /* 200, but empty */ }
```

### Two different behaviors on failure

`system/http` fails in two distinct ways, and you handle each differently:

- **A bad HTTP status (404, 500)** — does **not** throw, returns `{ ok: false, status }`. You must check
  explicitly.
- **Transport, timeout, a blocked address, an overflowed buffer** — **throws.** You need `try/catch`.

### Requests are made one at a time

`system/http` and the reads from `system/agent` **share one buffer of about 10 MB.** Two concurrent
operations give `E_SAB_BUSY`; a response larger than the buffer gives `E_SAB_OVERFLOW`.

```js
// NO
await Promise.all([Http.getJson(a), Http.getJson(b)]);

// YES
const first  = await Http.getJson(a);
const second = await Http.getJson(b);
```

### The limits you design within

| Resource | Cap |
|---|---|
| Memory of a script node | ~40 MB (≈30 MB code + ~10 MB shared buffer) |
| `dictionary` · `session` | 1.5 MB each, TTL 60 s |
| `session` values | string · finite number · boolean · null **only** — an object/array write throws at teardown (the script's dict changes + agent pushes are discarded, Error edge) |
| agent-state | 8 MB per entry, 200 entries per lane |
| Return value | must be **JSON-cloneable** — no functions, no classes |

There is no "make it bigger" button. Put a `limit` and a `per_page` on the requests, process in chunks.

### What's allowed in the sandbox

- Only `system/*` modules and **relative** imports to your own files. No npm packages, no absolute paths.
- No `fetch` — there is `system/http`. No `crypto` — there is `Tools.generateUUID()`.
- A **named** `exec` export is required. Not `export default`.
- A helper module that is only imported from another file needs no `exec` — it's a plain ES module.

### Test in a new chat

After a change to the tool's contract, the old transcript still holds the previous turns, including any
*"No tool response"*. You'll think the fix didn't take. **Start a new conversation.**

### Logs are the only window in production

The debuggers work only on the sandbox. In production what remains is `system/log`, with four levels —
**error, warning, info, debug.** Record which branch was taken, every external call with its status, and
every caught error. **Now, not later.**

---

## 10 · Which approach, when

A decision tree, in the order to ask the questions:

| Question | If yes |
|---|---|
| Is the work **one function** — call, transform, return? | **Script tool.** Stop here. |
| Is **judgment** needed inside — a second LLM? | **Flow tool** with an Agent node inside. |
| Are branches, waiting, a loop over a collection needed? | **Flow tool** — the graph expresses it, the file doesn't. |
| Is parallelism needed over a **dynamic** number of items? | **Parallel Context** inside a flow tool. |
| Are **N fixed distinct flows** needed at once? | **Parallel Flows + Flow Pointers.** |

### On parallelism — measured, not assumed

Instinct says parallel is faster. Here is what came out of five questions, each with one fast tool, three
runs each:

| Approach | Run 1 | Run 2 | Run 3 | Average | Tokens |
|---|---|---|---|---|---|
| Parallel fan-out | 32 s | 28 s | 28 s | ~29 s | 11845 / 714 |
| Sequential | 25 s | 27 s | 23 s | ~25 s | 11123 / 468 |

**Parallel was about 15% slower and costlier.** The reason is the number of model calls: sequentially the
main agent does about **6 rounds**; in parallel about **13** are done — three on the main agent plus two on
each of the five workers.

Concurrency wins **only when the per-item work dominates the branching overhead.** So the fan-out is worth
it for:

- a multi-round tool loop per item (2–3 calls per question);
- a slow external API — seconds per request;
- many more items (10–20+), where sequential time grows linearly;
- heavy per-item processing itself — summarising a long text, a chain of reasoning.

> **Measure before you complicate.** A parallel construction that doesn't win time is just more code to
> maintain — and a bigger bill.

---

## 11 · Checklist & symptoms

### Before you say "done"

**Registry**

- The file is under `src/scripts/tools/`, and `entry` starts with `tools/`
- `name` matches literally what's in the prompt catalogue
- The project was deployed again after the change

**Prompt**

- There is a full template of the `<SYSTEM CALL>` block
- Every tool has a **when-to-use** description, not just a context schema
- It's stated explicitly: one block per turn
- It's stated how to read the result and when not to call again

**Code**

- Named `exec` export
- Only `system/*` and relative imports
- Input is validated and returns a `correction`, not an exception
- `r.ok` and the shape of the body are checked
- HTTP requests are sequential, in `try/catch`
- One `reply` helper — and every exit goes through it
- `sessionID` is from `toolOptions.agentNode.flowContext.sessionId`
- A fresh `requestID` on every push
- A clean return after the accumulated writes

**Edges**

- The Fallback of every Agent node is wired
- The Error of every Script node is wired
- Every failure path reaches a clean answer to the caller

### Symptom → cause

| Symptom | Almost always |
|---|---|
| *"No tool response"*, but the logs show the tool ran | Missing or wrong `sessionID` on the push. Check the capitals too — `sessionId:` is silently ignored. |
| *"The requested tool does not exist"* | The name doesn't match, or the project wasn't deployed again — the registry is compiled at deploy. |
| *"No tool response"* and the script **never ran** (no log line at all) | The registered script `entry` isn't under `tools/` (or contains `..`), or a flow tool's `entry` doesn't resolve to a real start node — refused silently at call time; deploy does not catch it. |
| The agent never calls the tool | The catalogue is missing from the system prompt, or the LLM node carries the `skip-internal-tooling` special rule (`specialRules: [{ "type": "skip-internal-tooling" }]` — the engine's only tooling switch). |
| The agent shows raw protocol text | The markers aren't at the start of the line, or the prompt doesn't tell it not to show them. |
| Two tools called, one executed | Only the first block runs. The prompt must ask for one call per turn. |
| The agent spins the same tool in a loop | The prompt doesn't say to stop after `ok: true`. |
| The nested agent throws E6002 (Anthropic/Google) — or answers from its system prompt alone (OpenAI) | It wasn't seeded with a prompt. Use the flow tool's `flowContext.sessionId`. |
| The agent is silent, with no error at all | Start Flow / Start Node in the admin don't match the deployed project exactly (E5001). PascalCase, literal. |
| `E_SAB_BUSY` / `E_SAB_OVERFLOW` | Concurrent reads, or a response over ~10 MB. |
| The fix doesn't take in the same chat | The old transcript still holds the previous turns. New chat. |

---

## If you remember three things

1. **The answer travels through the conversation, not through `return`.**
2. **The session stamp is from `toolOptions.agentNode`, not from the bare `flowContext`.**
3. **You write the catalogue in the prompt — the engine does not generate it.**

---

*Protocol + loop, at reference level: `tool-calling.md`. Worked examples of both kinds: `building-tools.md`.
The Agent node: `nodes/agent-node.md`. Scripts & the `system/*` APIs: `nodes/script-node.md`.*
