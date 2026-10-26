# Gotchas & footguns — the sharp edges, in detail

The traps in this platform are almost never loud errors — they're **silent**: the thing saves, deploys,
runs, and then quietly does the wrong thing. This page catalogs every non-obvious trap we've hit, each as
**symptom → cause → fix**, grounded in the engine. Read it before building anything non-trivial; skim it
when something "works but doesn't."

Ordered by how much pain they cause, deepest first.

---

## A. Tools & the agent loop (the deepest, least obvious)

### A1. Agent says "No tool response" — but the tool ran and fetched data
- **Symptom:** the tool clearly executed (data in the logs), yet the agent replies "the tool isn't
  returning anything."
- **Cause:** the tool pushed its result **without the calling agent's `sessionID`**. The agent resolves
  its trigger **scoped to its own session** (the engine prefers a prompt whose `sessionID` matches). A push
  without the right `sessionID` lands in agent-state but is **invisible** to the re-invoked agent, which
  then finds only the original question (same `requestID` as the marker) → the engine synthesizes
  **"No tool response"**.
- **Fix:** stamp every reply with the caller's session:
  `Agent.setRootAgentPrompt(agentId, { prompt, sessionID: toolOptions.agentNode.flowContext.sessionId, requestID: Tools.generateUUID() })`.
  This is the **#1 tool bug**. See `tool-calling.md` §4.

### A2. `sessionID` / `requestID` — capital "ID", and read vs write differ
- **Symptom:** you added the session but it still doesn't work.
- **Cause:** the write payload fields are **`sessionID`** and **`requestID`** (capital `ID`). You **read**
  the value from `flowContext.sessionId` / `toolOptions.agentNode.flowContext.sessionId` (lowercase `Id`),
  but you **write** `sessionID:` / `requestID:`. `setRootAgentPrompt` reads `payload.sessionID`; write
  `sessionId` (lowercase) and it's silently `undefined` → A1 all over again.
- **Fix:** `sessionID: someLowercaseSessionIdValue`. Mind the case on the **write** key.

### A3. For a script tool, the bare `flowContext` is the TOOL's session — not the agent's
- **Symptom:** you used `flowContext.sessionId` for the reply; still "No tool response."
- **Cause:** a script tool runs with its **own fresh** session/request ids on the bare `flowContext`
  global. `flowContext.sessionId` ≠ the calling agent's session. (The caller's session *is* on the bare
  global too, as **`flowContext.parentSessionId`** — the engine stamps it on every tool flow and the
  reference clients forward it on each node call — but it is the same value as the path below.)
- **Fix:** the agent's session is on **`toolOptions.agentNode.flowContext.sessionId`** (= `flowContext.parentSessionId`)
  — use that, never `flowContext.sessionId`, for the reply.

### A4. Nested flow tool — where `toolOptions` is NOT there
- **Symptom:** a flow tool's return step can't find the outer/main agent (M) — `toolOptions` is
  `undefined` there.
- **Cause:** inside the flow tool `toolOptions` points to **M** on every node of the flow tool — the
  flow-engine copies the inbound pack onto same-flow continuations, and the reference clients (test
  harness, entanglement, agent-runner) re-seed every nodeTask of a `toolFlow` bundle from `flow.options`.
  The inner agent A's own tool loop does **not** overwrite it: `{ toolResponse, promptMarker }` rides only
  on A's re-dispatch to itself. The pack is **absent** in a **Run Flow / Parallel** sub-flow spawned from
  inside the tool flow (spawned bundles don't inherit `options`), and with a **custom client** that does
  not re-seed.
- **Fix:** **capture M's identity into the dictionary at the FIRST node** — a defensive bridge that covers
  both cases: `dictionary.mainAgentId = toolOptions.toolContext.agentId; dictionary.mainSession = toolOptions.agentNode.flowContext.sessionId;`
  then read them back at the return node. The dictionary is shared across the tool flow and its Run Flow
  children. See `building-tools.md` Example C.

### A5. A nested inner agent needs a trigger, or it errors (E6002)
- **Symptom:** the inner agent of a flow tool throws "at least one user message" (E6002) instead of
  answering.
- **Cause:** an Agent node reads its "user message" from the **prompts** store (its `agentId` bucket).
  Nothing auto-seeds a trigger for a **nested** agent — it has no user message.
- **Fix:** seed it in the flow tool's setup Script, stamped with the **flow tool's** session (that's the
  inner agent's session, = the bare `flowContext.sessionId`):
  `Agent.setRootAgentPrompt('inner-agent', { prompt: toolOptions.toolContext.options.context, sessionID: flowContext.sessionId, requestID: Tools.generateUUID() })`.
  Note this uses `flowContext.sessionId` (the flow tool's session) — the **opposite** of A3, because now
  you're triggering the *inner* agent, not replying to the *outer* one. Two different sessions in one file.

### A6. The script's `return` is NOT the tool's answer
- **Symptom:** you `return { result }` and the agent never sees it.
- **Cause:** a tool's return value only ends the run; it is **not** fed to the LLM. The answer travels
  through the **conversation** (an `Agent.setRootAgentPrompt` push).
- **Fix:** always push the answer with `Agent.setRootAgentPrompt(...)`; `return { done: true }` just closes
  the run cleanly.

### A7. Only the FIRST `<SYSTEM CALL>` block is executed
- **Symptom:** the model emitted two tool calls; only one ran.
- **Cause:** the engine dispatches `parsedCalls[0]` even though it parses all blocks.
- **Fix:** author the System prompt so the model emits **one** call per turn.

### A8. The engine does NOT generate the tool catalogue or the `<SYSTEM CALL>` instructions
- **Symptom:** the agent never calls a registered tool, or emits malformed calls.
- **Cause:** the engine only **parses** the block and resolves `!*tool`. It writes **no** tool list and
  **no** format instructions. `Tool` has only `{ name, type, entry }` — no description/usage.
- **Fix:** author BOTH the `<SYSTEM CALL>` format instruction AND the tool catalogue (name + description +
  usage, in Markdown) into the agent's **System** prompt. See `tool-calling.md` §5.

### A9. `!*action` doesn't route — `type` in `keen-tools.json` does
- **Symptom:** you changed `!*action` expecting different behavior; nothing changed.
- **Cause:** the engine never reads `!*action` for routing. Script-vs-flow is decided by the resolved
  tool's **`type`**.
- **Fix:** treat `!*action` as a human label; set behavior via the tool's `type` (`script` / `flow`).

### A10. "The requested tool does not exist" though it's in `keen-tools.json`
- **Symptom:** a registered tool isn't found.
- **Cause:** the runtime registry is the **compiled** `flows/init.map.js` (built from `keen-tools.json` at
  **deploy**), not the file directly — or the `!*tool` name ≠ the registry `name`.
- **Fix:** re-**deploy** (`keen-deploy`, or Connect → Upload in the extension) after editing
  `keen-tools.json`; match the name exactly.

### A11. A bad tool call re-loops the agent — it doesn't take Fallback
- **Symptom:** you wired the Agent's Fallback edge for tool failures; it never fires.
- **Cause:** a bad `<SYSTEM CALL>`, unknown tool, or "tool pushed nothing" all re-loop the agent with a
  corrective user message. **Fallback fires only on a provider/LLM-call failure** (auth, rate-limit,
  timeout, 4xx/5xx) — or a config / payload error raised before the call (`E6101`: missing
  agentId/agentName/llm, unknown provider or model; `E6002`: no user message). Unwired, those continue on
  `next_1` with the error text as the answer (A12).
- **Fix:** for tool-shape problems, make the tool **self-correcting** (reply with what's missing). Reserve
  Fallback for provider failures.

### A12. Unwired Fallback / Error edges — failures go silent or garbled
- **Symptom:** a tool "works" in the happy path but does something bizarre (or nothing) when the model
  provider hiccups or a script throws.
- **Cause:** an **Agent node's Fallback (`error`) is unwired** → on a provider failure the flow continues
  out `next_1` **with the error text recorded as the agent's "answer."** A downstream step that reads that
  answer (e.g. a return bridge) then forwards the **error string as if it were a real result**. And a
  **Script node's Error (`error`) is unwired** → a throw just **ends that branch**, so a tool pushes
  nothing and the caller gets "No tool response."
- **Concrete example:** in a nested flow tool, if the inner agent's provider call fails and its Fallback
  is unwired, the return script reads the error text via `getAgentLastResponse` and hands it to the outer
  agent as a "description" — a **garbled success**, worse than a clean error.
- **Fix:** **wire the failure paths.** Route the inner Agent's **Fallback** and each Script's **Error** to
  a small step that returns a **clean, explicit failure** to the caller (a Script that pushes
  `{ ok:false, error:"…" }` to the calling agent with the right `sessionID`). Don't trust the happy path —
  a robust tool **always** returns *something* meaningful to its caller, success or failure. See
  `building-tools.md` → "Wire the failure paths."

### A13. Nested flow tool — is the return to the outer agent race-safe?
- **The worry:** a flow tool runs an inner agent (+ its own inner tool loop) and only pushes back to the
  outer agent at the end (`returnToMain`). Does the outer agent's tool-response re-dispatch fire *before*
  that push lands (→ "No tool response")?
- **Answer: no race — by client-SDK contract.** The client that drives the loop keeps the tool-calling
  node **pending until ALL child flows drain** (recursively — it pauses until the last child's end signal
  lands), *then* fires the parent's continuation. So the outer agent's re-dispatch only runs after the
  flow tool has reached its End (which is after `returnToMain` pushed). The reference SDKs (the test
  harness and the entanglement partner client) both implement this.
- **The caveat (important):** this is a **client responsibility, not an engine guarantee.** The engine is
  a pure function; the client drives the loop. A **custom client** that fires the parent continuation
  early — in parallel with the child flows, without waiting for them to drain — **would** race and get
  intermittent "No tool response" on slow tools. Any client MUST keep the spawning node pending until
  every child (recursively) completes.

---

## B. Data & placeholders

### B1. `${...}` only understands `dictionary` and `session` — nothing else
- **Cause:** the resolver regex is `/\$\{(dictionary|session)\.([^}]+)\}/g`. No `agent`, `input`, `env`,
  `settings`, `document`, or channel roots.
- **Fix:** to use anything else in a field, a Script must copy it into the dictionary/session first.

### B2. Condition: a **bare** `dictionary.x` throws
- **Symptom:** "Member access is not allowed" / "Identifier … is not allowed".
- **Cause:** the condition substitutes `${...}` then jsep-evaluates; a bare `dictionary.x` is parsed as a
  member expression → rejected.
- **Fix:** wrap the reference: `${dictionary.x} > 25`. Operands are literals + `${...}` placeholders only.

### B3. Loop / Parallel-Context references need the root prefix
- **Symptom:** LoopNode "invalid value/setto"; Parallel Context does nothing.
- **Cause:** Loop `value`/`setto` and Parallel Context `contextCollection` are **path references** that
  must start with `dictionary.` (or `session.` for Loop). A bare name resolves to nothing / throws.
- **Fix:** use `dictionary.items`, not `items`. Point a Loop's **Read from** at the dictionary: a
  `session.<key>` source is accepted, but a session value is always a primitive (`data-model.md`), so
  that loop goes straight to Finish. A `session.<key>` **Set to** works only for primitive elements.

### B4. Assignment: a plain `"1"` stays the **string** `"1"`
- **Symptom:** a later `${dictionary.n} > 25` compares wrong / is always false.
- **Cause:** no numeric coercion — a literal value is stored as typed (a string).
- **Fix:** store a real number via a whole-string placeholder that resolves to a number
  (`"${dictionary.count}"`), or coerce in a script (`Number(props.n)`).

### B5. `${dictionary.a.b}` nests; `${session.a.b}` does NOT
- **Cause:** dictionary lookups walk dot-paths; session lookups treat the whole path as **one flat key**.
  No array indexing anywhere (`list[0]` / `list.0` resolve to nothing).
- **Fix:** keep session keys flat; for arrays, index inside a Script, not in a placeholder.

### B6. Identity is NOT in the session — and no script can fetch it either
- **Symptom:** `${session.userEmail}` / `${session.sessionID}` is empty.
- **Cause:** the session is **seeded empty**. Run identity (userId, email, agentId, chatId, …) lives in an
  **engine-internal** `treeContext` that **no placeholder, node or script can read**: a Script sees only
  the per-call `flowContext` global (`correlationId` / `sessionId` / `requestId` / `flowId` /
  `parentFlowId` …) and, inside a tool flow, `toolOptions.toolContext.agentId`.
- **Fix:** don't rely on session identity keys unless a node wrote them — and nothing inside the flow can
  write the *user's* identity. If a flow needs who-the-user-is, it must **arrive from the client** (in
  the prompt, or as Script props); a node can then copy it into the dictionary/session.

---

## C. Nodes & the canvas

### C1. Two "Assign results" fields that the engine ignores
- **Symptom:** you set Parallel Context's **Assign result** (or Parallel Flows' **Assign results**) and
  the result isn't there.
- **Cause:** both are **no-ops** — the form even requires Parallel Context's, but the engine never reads
  it. Parallel Context merges each run's dict back into `collection[i]`; Parallel Flows siblings report via
  **channels**.
- **Fix:** read Parallel Context results from the collection; use channels for Parallel Flows.

### C2. Dynamic `${}` flow targets are blocked by the canvas form
- **Symptom:** you want a Run/Jump/Flow-Pointer target computed at runtime.
- **Cause:** the engine *does* interpolate a Run / Jump / Flow Pointer target (not a Parallel Context
  pipe), but the form regex (`^[A-Z][a-zA-Z]*-[A-Z][a-zA-Z]*$`) rejects `$ { } .` and digits, and
  `keen-validate` applies the same rule as an error. A hand-written dynamic value fails validation and is
  stripped on the next canvas save.
- **Fix:** treat flow targets as **literal** `File-Label`s.

### C3. Join is a pass-through, not a barrier
- **Symptom:** you used a Join to "wait for both branches"; the downstream ran twice.
- **Cause:** Join emits `next_1` on **every** arrival; it does not synchronize.
- **Fix:** for a real barrier, use **Parallel Flows** + the **Wait** handle.

### C4. The Note node can't be wired
- **Cause:** Note has **no handles** — it's a comment, never in an edge, never runs.
- **Fix:** for "do nothing then continue," use a **Join** (has dots), not a Note.

### C5. Two naming rules — don't swap them
- **Cause:** **Agent ID** is kebab-case (`agent-one`); **Start Flow / Start Node** are PascalCase
  (`MainFlow` / `Start`). The forms reject the wrong format.
- **Fix:** slugs lowercase-dashes; flow/node names Capitalized-letters.

### C6. Start Flow / Start Node must match the deployed project **exactly**
- **Symptom:** the agent saves fine but never runs.
- **Cause:** the admin's Start Flow / Start Node don't match a real flow file + start-node label in the
  deployed project (`E5001`). It's a **silent** break — nothing errors in the form.
- **Fix:** use the exact names your project contains; never a made-up placeholder.

### C7. Parallel Context elements should be plain objects
- **Cause:** non-object elements are replaced with `{}` before each run — a run over `[1,2,3]` sees `{}`.
- **Fix:** wrap scalars: `[{v:1},{v:2}]`.

### C8. Write the canvas handle ids — the compiler renames four of them
- **The rule:** an edge's `sourceHandle` is the **canvas** handle id of that dot. For most nodes that id
  already **is** `next_1` (Agent, Script, Assignment, Run Flow, Join, Parallel Flows, Parallel Context, and
  a Loop's Finish), plus `error` on Agent / Script. Only four canvas ids differ from the engine's routing
  keys, and the **deploy compiler** renames them: Start / Flow Pointer `next`→`next_1`, Condition
  `true`→`next_1` and `false`→`next_2`, Loop body `out`→`next_2`.
- **Don't pre-compile:** never write `next_1` / `next_2` on a Condition, `next_2` for a Loop body, or
  `next_1` on a Start / Flow Pointer. `keen-validate` rejects a `sourceHandle` that isn't one of the
  node's canvas ids, and the canvas wouldn't draw it. The full table is in `field-rules.md` → *Handle
  ids*.

### C9. A digit in a flow file name makes the flow untargetable
- **Symptom:** `Report2.flow` works as an agent's Start Flow, but no Run / Jump / Flow Pointer / Parallel
  Context node and no flow tool can reach it.
- **Cause:** the flow file name and the agent's Start Flow allow digits (`/^[A-Z][A-Za-z0-9]*$/`), but
  every `File-Label` target is letters only (`/^[A-Z][a-zA-Z]*-[A-Z][a-zA-Z]*$/`), and so is a Start label.
  `keen-validate` warns on a flow file name with digits.
- **Fix:** name flow files letters-only PascalCase (`ReportTwo.flow`).

---

## D. Scripts

### D1. Must export a named `exec` — nothing else runs it
- **Cause:** the runner reads the `exec` export; no `exec` → Error edge. Not `export default`.
- **Fix:** `export const exec = (props) => {…}`.

### D2. Only `system/*` and relative imports
- **Cause:** npm packages and absolute paths are forbidden; only `system/*` and `./`/`../` project files.
- **Fix:** put shared code in your own relative files; use `system/http` for network.

### D3. `system/http` — two different failure modes
- **Symptom:** an unhandled rejection kills the node, or a bad status silently passes.
- **Cause:** an HTTP **error status** returns `{ ok:false, status }` (doesn't throw); a **transport /
  timeout / SSRF / buffer** failure **throws**.
- **Fix:** check `r.ok` **and** wrap in try/catch.

### D4. `E_SAB_BUSY` / `E_SAB_OVERFLOW`
- **Symptom:** a script throws one of these under concurrent reads.
- **Cause:** `system/http` and `system/agent` reads share **one ~10 MB buffer**, one op at a time.
  `Promise.all([...])` of two reads → `E_SAB_BUSY`; a response bigger than the buffer → `E_SAB_OVERFLOW`.
- **Fix:** `await` reads **sequentially**; never parallelize them.

### D5. A throw rolls back dictionary + agent writes
- **Symptom:** partial dictionary changes vanish after an error.
- **Cause:** on a throw, dictionary writes are discarded (all-or-nothing) and queued agent writes are
  dropped; only **session** writes persist on the error edge.
- **Fix:** catch what you can recover from; expect a throw to undo dict/agent work.

### D6. The return value must be structured-cloneable
- **Cause:** a function/class-instance return can't be copied out of the sandbox → Error edge.
- **Fix:** return plain data.

### D7. `crypto` doesn't exist in the sandbox
- **Cause:** the isolate is bare V8.
- **Fix:** `system/tools` `generateUUID()` / `getTimestamp()`.

---

## E. Project, deploy & testing

### E1. `keen-tools.json` / any change needs a re-deploy
- **Cause:** the runtime registry compiles at deploy; a local edit isn't live until the upload succeeds
  and the engine cache swaps. In the extension, auto-sync only re-uploads **while it stays connected**.
- **Fix:** re-deploy after edits — `keen-validate` → `keen-deploy` (it answers `deployed` / `rejected`),
  or Connect → Upload in the extension; watch for "Cache swapped" in the logs.

### E2. Test tool changes in a **new chat**
- **Symptom:** after fixing a tool, the same chat still shows "No tool response".
- **Cause:** the old transcript still holds the stale tool turns.
- **Fix:** start a fresh chat to test a tool-response contract change.

### E3. `system/log` is your only production window
- **Cause:** the flow/script **debuggers are sandbox-only**; production has none.
- **Fix:** log the branch taken, each external call + status, every caught error — now, not later.

### E4. Deploy the whole project together
- **Cause:** flows, scripts and the registry compile as one bundle; a partial change can leave the runtime
  referencing something that isn't there.
- **Fix:** upload the whole `src/` (`keen-deploy` and the panel both do this); don't hand-patch one file
  on the server.

---

## F. Channels (agent conversation lanes) — the subtlest of all

Channels are the deepest trap set, because reads and writes are **asymmetric** and everything defaults to
`'root'` so the asymmetry stays hidden until you use a second channel.

The model: agent state is two documents — a **prompts** store and a **responses** store — each shaped
`{ agentId: { channel: [newest-first] } }`. Default channel `'root'`.

### F1. Per-agent reads are ROOT-ONLY; the trigger flattens ALL channels
- **The asymmetry (verified):** `getAgentLastResponse` / `getAgentLastResponses` /
  `getAgentLastResponseByRequestId` / `…BySessionId` read **only `$.<agent>.root`** (channel defaults to
  `'root'`). But an **Agent node's trigger** resolution flattens across **all** of the agent's channels
  (`Object.values(prompts[agent]).flat()`, newest-first).
- **Consequence:** a prompt on **any** channel can wake the agent, but the per-agent getters only ever see
  the **root** lane.

### F2. The agent's answer inherits the TRIGGER's channel — the killer
- **Symptom:** you triggered an agent on channel `com`; later `getAgentLastResponse(agent)` returns
  nothing (or a stale root answer).
- **Cause:** the agent's response **inherits the channel of the prompt that triggered it**
  (`channel: rootPrompt?.channel`). Trigger on `com` → the answer lands on `com`. But
  `getAgentLastResponse` reads **root** → it misses the `com` answer entirely.
- **Fix:** read the answer on the **same channel** you triggered on:
  `Agent.getChannelResponses('com')` (spans all agents on that channel), **not** `getAgentLastResponse`.
  Or — simplest — **keep everything on root** unless you truly need parallel lanes. (This is exactly why
  a nested flow tool's return step reads the inner agent's answer only if the inner agent was triggered on
  **root** — see `building-tools.md` Example C.)

### F3. A prompt on ANY channel triggers the agent
- **Symptom:** you pushed to a "side" channel to stage something, and the agent ran anyway.
- **Cause:** trigger resolution flattens all channels — you can't hide a `role:'user', agentChat:true`
  prompt from the agent by putting it on a non-root channel.
- **Fix:** don't use channels as a "not yet" queue; the newest user+agentChat prompt on any channel is a
  live trigger.

### F4. `consumeChannel*` DRAINS — read + delete
- **Symptom:** a second reader of the same channel gets nothing.
- **Cause:** `consumeChannelPrompts` / `consumeChannelResponses` read **and delete** the channel across all
  agents (`JSON.GET` then `JSON.DEL` in one MULTI). It's a one-shot hand-off.
- **Fix:** use the non-destructive `getChannelPrompts` / `getChannelResponses` unless you deliberately want
  exactly-once consumption. Two consumers can't both drain the same lane.

### F5. Channel reads span ALL agents; per-agent reads span one agent
- **Cause:** `getChannelResponses(channel)` reads `$.*.<channel>` — **every** agent's bucket on that lane.
  Per-agent getters read one agent's **root**. A channel is a **cross-agent** lane; an agent's root is
  **per-agent**.
- **Fix:** pick the read that matches your intent — cross-agent lane vs one agent's root history.

### F6. `deleteChannel(channel, { affectDB: true })` is destructive beyond the run
- **Cause:** it deletes the channel across all agents **and** signals the platform to purge that channel's
  persisted `chat_history` rows.
- **Fix:** use `affectDB` only when you mean to erase persisted history, not just the in-run lane.

### F7. Parallel clones + channels — session scoping is load-bearing
- **Cause:** N `parallelContext` clones drive the **same** `agentId` concurrently; each writes its trigger
  on its **own session**. Trigger resolution is **session-scoped** so a clone reads its own trigger, not a
  sibling's. (This was a real "3-of-4 clones got the wrong trigger" bug.)
- **Fix:** in parallel multi-agent pipelines, always stamp pushes with the right **session**, and read with
  session-scoped getters (`…BySessionId`) or the correct channel — never a bare newest-across-all read.

**Channels, in one line:** *writes and per-agent reads default to `root`; the trigger sees every channel;
the answer lands on the trigger's channel. So if you leave root, you must read on the channel you wrote —
and remember the drains delete.*

---

## How to read a "silent" failure

When something "works but does the wrong thing," check in this order:
1. **Did it deploy?** (E1) — most "my change did nothing" is a missing re-upload.
2. **Names match?** (C6, A10) — Start Flow/Node and tool names are exact-match, silent on mismatch.
3. **Session on the push?** (A1–A3) — the #1 tool bug.
4. **The right store / prefix / type?** (B2–B4) — bare `dictionary.x`, `"1"` as string, missing prefix.
5. **The logs** (E3) — the platform's logs: did the tool run? did the agent see the result?

*Each entry links to the fuller treatment in its topic file; this page is the fast index of dragons.*
