# The business objects — dictionary, session & the conversation

A flow moves data through itself using a few **shared objects**. This page explains **what they are, what
they're for, and how data travels from one node to the next** — in plain terms, not how the platform is
built. (For the technical reference — limits, exact syntax — see `data-model.md`.)

---

## The one idea that makes flows click

**Edges carry control, not data.** The lines you draw between nodes say *"run this next"* — they do **not**
hand a value from one box to the next. Data lives in **shared objects** that every node in the flow can
reach. So the real pattern is always:

> a node **writes** a value into a shared object → a later node **reads** it back.

Ask *"how does the number I computed in node A get to node B?"* — the answer is never "along the wire."
It's: **A writes it to the `dictionary`, B reads `${dictionary.…}`.** The wire just decides the order.

There are three shared objects, each with a different **reach**:

| Object | Reach | Think of it as… |
|---|---|---|
| **`dictionary`** | one flow | the flow's **notebook** — working data while this flow runs |
| **`session`** | the whole run | a **sticky note on the wall** — small facts everyone in the run can see |
| **the conversation** (channels) | the whole run | the **chat transcript** — messages to and from the agents |

---

## `dictionary` — the flow's notebook

**What it is:** a place to put values while a flow works — inputs, intermediate results, the answer you're
building. It holds anything: text, numbers, lists, nested objects.

**What it's for:** carrying data **between the nodes of one flow**. Node A computes something and writes it;
node B, C, D read it. It's the main way steps in a flow share results.

**How you use it:**
- **Write** with an **Assignment** node (`prop → value`), a **Script** (`dictionary.total = 42`), or an
  **Agent** (which can drop its answer into a property).
- **Read** anywhere a field allows it, with `${dictionary.someProp}` (or in a Script, the `dictionary`
  object directly).

**How it travels between flows** (its reach is *one flow*, so this matters when flows call flows):
- A **Run Flow** sub-flow **shares the caller's notebook** — it reads and writes the same one, so it can
  hand a result back.
- A **Parallel Context** run gets its **own private copy of one item** from a list (and its finished
  notebook becomes that item's result).
- A **Parallel Flows** branch gets a **fresh, empty notebook** of its own — nothing shared, nothing
  handed back (those branches report results through the conversation instead).

**Its life:** the dictionary belongs to a single **run**. When the run ends, it's gone. It is **not** a
database — don't expect it to remember anything for the next chat.

---

## `session` — the shared sticky note

**What it is:** a small set of simple **key → value** facts (text, numbers, true/false) shared by
**everything in the run**.

**What it's for:** a value that isn't "this flow's working data" but "something the whole run should know"
— a user's chosen language, a feature flag, an id you set once and reuse in several flows.

**How you use it:** write/read it from a **Script** (`Session.setSessionValue('lang','en')` /
`Session.getSessionValue('lang')`), and read it in any field with `${session.lang}`.

**Reach:** the **whole run** — every flow, every sub-flow, every parallel branch sees the same session.
That's the difference from the dictionary: the dictionary is per-flow working data; the session is
run-wide shared facts.

> **One exception — `${session.*}` inside an Agent node of a Parallel Context clone.** Scripts and flow
> nodes always read the run's one session. An **Agent** node resolves its `${session.*}` placeholders
> (prompts, agentId/sessionId fields) against the session keyed by its own flow's session, which exists
> only when that is the run's root session. Inside a Parallel Context clone (a fresh session per clone) —
> or a nested tool flow / a branch spawned from a clone — `${session.lang}` in an Agent prompt comes back
> **empty**. Put such values in the clone's **dictionary** (e.g. an item field `{ q: "…", lang: "bg" }`) and
> read `${dictionary.lang}` instead.

**Keep it small and simple — and flat by rule, not by taste:** a session value **must** be a string, a
finite number, a boolean or `null`. An object or array write (`Session.setSessionValue('x', { a: 1 })`,
`Session.x = [...]`) does **not** warn — it **throws at teardown**, after your script has returned, which
discards the script's dictionary changes and its queued agent pushes and routes the node to its Error
edge. Use the dictionary for structured or heavy, per-flow data.

---

## The conversation (channels) — messages to and from agents

**What it is:** the running **chat** — the user's messages and the agents' answers, plus any messages your
flow sends to an agent or one agent sends to another.

**What it's for:** it's how **agents** get their input and how you read their output. When a user writes to
the chat, that message becomes the agent's prompt; when the agent answers, that answer goes back into the
conversation.

**Channels:** the conversation can have named **lanes** ("channels"). Everything lives on the default lane
unless you pick another. Lanes let you run **separate conversations in parallel** without mixing them — for
example a `questions` lane and an `answers` lane in a multi-agent pipeline.

**How you use it:**
- An **Agent** node automatically reads the latest user message as its prompt and posts its answer back.
- A **Script** can **send** a message to an agent — stamped with the session that agent runs on and a
  fresh id: `Agent.setRootAgentPrompt('my-agent', { prompt, sessionID: flowContext.sessionId, requestID: Tools.generateUUID(), channel })`
  — and **read** an agent's reply (`Agent.getAgentLastResponse('my-agent')`, or by channel).

**Reach:** the whole run, organised by agent and lane.

---

## How data flows through a flow — a worked example

```
Start ─▶ Assignment ─▶ Agent ─▶ Script ─▶ End
```

1. **Start** — the user's message enters the **conversation** (it becomes the agent's prompt later).
2. **Assignment** — writes `dictionary.topic = "orders"`. (Into the notebook.)
3. **Agent** — its prompt reads `${dictionary.topic}`, so it answers about orders; its answer goes into the
   **conversation** (and it can also drop the answer into `dictionary.answer`).
4. **Script** — reads the agent's answer (`Agent.getAgentLastResponse('my-agent')`), does something with it,
   and writes `dictionary.result`.
5. **End** — the flow finishes; whatever is in the dictionary/session is the run's state at that point.

Notice: **no value ever travelled along an arrow.** Each node dropped its output into a shared object, and
the next node picked it up. The arrows only set the **order**.

---

## Which object should I use?

- **"I need this value later in *this* flow."** → **dictionary** (`${dictionary.x}`).
- **"Every flow in the run needs this simple fact."** → **session** (`${session.x}`).
- **"I'm talking to an agent / reading its answer."** → the **conversation** (channels, via the Agent and
  Script nodes).

And remember the golden rule: **write it to a shared object, read it back later — the wires are just the
running order.**

*Technical details (exact syntax, size limits, how each composition node scopes the dictionary) live in
`data-model.md`.*
