# The life of a flow — start, receive, evolve, exit, die

What happens from the moment a flow begins to the moment it ends — in plain terms (not how the platform is
built). Read `business-objects.md` first for what the shared objects are.

---

## 1. How a flow starts

A flow doesn't start "at the top of the file" — it starts at a **Start node**, and the caller chooses
**which** one by its **`File-Label`** address:

- When a **chat message** arrives, the platform starts the agent's flow at the Start node the agent points
  to (its **Start Flow / Start Node**).
- When another flow calls in — **Run Flow**, **Jump Flow**, **Parallel Flows**, **Parallel Context** — it
  names a `File-Label`, and the flow starts at that Start node.

So "start" = *enter at a chosen door and follow the wiring out of it.*

## 2. What a flow receives when it starts

It depends on **how** it was started:

- **The user's message** — for a chat run, the person's message is placed into the **conversation** for
  the agent. That's what an **Agent** node will pick up as its prompt.
- **The session** — the run-wide shared facts are already there (a chat run starts with an empty one; a
  sub-flow sees whatever the run has accumulated).
- **The dictionary** — depends on the kind of start:
  - a **top-level** flow begins with an **empty** dictionary;
  - a **Run Flow / Jump Flow** child **inherits the caller's** dictionary (it sees everything the caller
    wrote);
  - a **Parallel Context** run begins with a **copy of one item** from the collection;
  - a **Parallel Flows** branch begins with a **fresh, empty** dictionary.

So a flow receives: *the conversation so far, the shared session, and a dictionary that's either empty,
inherited, or seeded — depending on who started it.*

## 3. How what it receives evolves

As control walks from node to node, the shared objects **change**:

- An **Assignment** or **Script** writes values into the **dictionary**.
- An **Agent** reads the latest user message from the **conversation**, thinks (maybe calls tools), and
  writes its answer back into the **conversation** (and optionally into the dictionary).
- A **Loop** walks a list, handing one item at a time to its body.
- A **Condition** branches on what the dictionary/session now hold.
- A **Script** can put facts on the **session** for the rest of the run.

Every node reads the current state, does its bit, and leaves the state a little further along. That
evolving state — dictionary + session + conversation — **is** what "the flow is doing".

## 4. How a flow exits, and what it gives

A flow **exits** when it reaches an **End** node (or a branch simply runs out of wiring). What it "gives"
depends, again, on how it was started:

- **A chat run** → the user gets the **agent's answer(s)**, streamed to their screen as they were produced.
  The final state (dictionary/session/conversation) is simply where the nodes left it.
- **A Run Flow** sub-flow → **returns to the caller**, and because it shared the caller's dictionary, any
  values it wrote are now visible to the caller.
- **A Parallel Context** run → its finished dictionary **becomes that collection item's result** (read
  them back from the collection after it's done).
- **A Parallel Flows** branch → just **ends**; it shared no dictionary, so it reports results through the
  **conversation** (channels), not a return value.
- **A Jump Flow** target → **finishes there** (the jump didn't come back).

So "gives" ranges from *a visible answer to the user* to *updated shared data the caller can read* to
*nothing but a completed side-effect* — matching the composition node that started it.

## 5. What happens when a flow dies

"Dies" = it doesn't finish normally. Three ways, and what each means for you:

- **The user cancels** (stops it, or sends a new message that supersedes it): the run is **cancelled** —
  in-flight work stops, and the run's working memory (dictionary, session, conversation, etc.) is **cleaned
  up**. Nothing half-done lingers.
  <!-- UNVERIFIED (audit 2026-09-12): "a new message supersedes the run" is relay/client behaviour that was
  not checked; the engine side (cancel → abort in-flight + wipe dict/session/agent-state/cookies/treeContext)
  is confirmed. -->

- **A node errors** (a Script throws, the LLM provider fails):
  - if the node's **error path is wired** — **Script → Error**, **Agent → Fallback** (on a provider
    failure or a broken node configuration) — control takes that path so you can handle it;
  - a **Script**'s failed writes are **rolled back** (its dictionary changes are discarded — all-or-nothing;
    session values it set before the error are kept so an error-handler can read them);
  - if **nothing handles** the error: a Script's **branch just stops**; an Agent **continues out `next_1`
    with the error text as its answer** (see `nodes/agent-node.md` → *Fallback*).
- **It's abandoned / times out** (the user walks away): the run's working memory **expires on its own**
  shortly after — because these objects are **short-lived working memory, not a database**.

The one thing to internalise: **all of this state belongs to a single run.** When the run ends — cleanly,
cancelled, or crashed — that memory is reclaimed. The **next** chat starts fresh; nothing here is durable.
If you need something to survive across runs, persist it outside the flow (e.g. via a Script calling your
own storage over `system/http`).

---

## The shape of a run, at a glance

```
enter at a Start (chosen by File-Label)
   → receive: the user's message (conversation) + shared session + an empty/inherited/seeded dictionary
   → evolve:  each node reads state, does its work, writes state
   → exit at End: give back an answer / updated shared data / a completed side-effect
   ↳ if it dies (cancel / unhandled error / walk-away): working memory is cleaned up; next run starts fresh
```

*See `business-objects.md` for the objects, `data-model.md` for the exact rules, and `nodes/*.md` for each
node.*
