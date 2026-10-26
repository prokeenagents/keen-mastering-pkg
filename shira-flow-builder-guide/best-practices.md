# Best practices, requests, limits & integrations

Practical rules for writing flows and scripts that behave in production: how to make requests, what limits
a single node runs under, when to guard with try/catch, why to log, when your code is "invalid", and how
Settings + cookies combine for an integration like Google.

---

## Canvas layout — give nodes room (spacing rule)

When you place nodes (each node's `position: { x, y }`), **leave a clear gap of at least 1.5× the node
size between neighbouring nodes.** A node card is **~170px** wide (Parallel Context is 200, a Note is
500), so 1.5× ≈ **255px of empty space** between two cards.

- **Down a chain** (the normal top-to-bottom or left-to-right flow): put successive node **centres about
  400–450px apart** in the flow direction — that is the ~170px card **plus** the ~255px gap. On the grid
  that is a step of **432px** (27 × 16), which the examples in this guide use.
- **Across parallel branches** (a Condition's two edges, a Parallel Flows fan-out): keep a **≥255px gap**
  between neighbouring branches' cards on the cross axis (centres ~432px apart) so their cards and edges
  never overlap.
- Snap `x` / `y` to the **16px grid** (the canvas snaps to 16px; keep coordinates on multiples of 16).
- This is the one spacing rule for the whole guide — `nodes/start-flow-node.md` and the examples follow it.

**Why:** at that spacing the edges stay clear of the node cards, the graph is readable, and a human can
follow and edit the flow you built. Cramped nodes produce crossing edges and an unreadable canvas — the
flow still runs, but nobody can maintain it. So: **never place two nodes closer than 1.5× a node's size.**

---

## Making requests (from a Script)

A flow itself has no network. To call anything external you use **`system/http`** from a **Script node**
(the sandbox has no `fetch` of its own — the host makes the call for you):

```js
import Http from 'system/http';
export const exec = async (props) => {
    const r = await Http.getJson(`https://api.example.com/orders/${props.id}`);
    if (!r.ok) { /* HTTP error status — r.status tells you which */ }
    return r.body;
};
```

**The kinds of request** (five methods) — every one returns `{ ok, status, body }`:

| Method | Use |
|---|---|
| `get(url, opts?)` | GET, `body` = raw text |
| `getJson(url, opts?)` | GET, `body` = parsed JSON |
| `post(url, body, opts?)` | POST (string as-is, object JSON-encoded), `body` = text |
| `postJson(url, json, opts?)` | POST JSON (sets content-type), `body` = parsed JSON |
| `request({ url, method, headers, body })` | full control (any method + custom headers) |

`opts.headers` sets request headers on the four helpers. A request times out after **15 s** and follows at
most **3** redirects — both failures **throw**.

**Two response outcomes to handle:**
- **HTTP error status** (404, 500, …) → `{ ok:false, status }` — **check `r.ok`**, it does *not* throw.
- **Transport / policy failure** — a network error, **timeout**, a blocked scheme or a **blocked
  SSRF/internal address**, or a buffer error — **throws** → wrap in **try/catch**.

> **SSRF protection:** `system/http` refuses non-`http(s)` schemes and internal/private addresses — you
> can't use it to reach the platform's own services or a local network. It's for real external APIs.

---

## Limits on a single node execution (especially a Script node)

Each node runs under real bounds — know them so a node doesn't fail unexpectedly:

**Script node (the tightest):**
- **Memory: ~40 MB** per run (≈30 MB for your code + a shared ~10 MB buffer). A node that allocates past
  that **fails and takes its Error edge** (if wired) instead of destabilizing the run — process big data in
  chunks, don't load a 50 MB blob into the isolate.
- **One buffer op at a time:** `system/http` and `system/agent` reads share that ~10 MB buffer. Running two
  at once throws **`E_SAB_BUSY`**; a response bigger than the buffer throws **`E_SAB_OVERFLOW`**. So
  **`await` each HTTP/agent read sequentially — never `Promise.all` them.**
- **The return value must be JSON-cloneable** (plain data — no functions/classes), and small-ish.
- **Fresh sandbox per run** — nothing persists in the script between runs; use the dictionary/session.

**All nodes — the shared stores have caps:**
- **`dictionary`** ≤ **1.5 MB**, **`session`** ≤ **1.5 MB** (and session values must be flat primitives).
- **agent-state**: ≤ 8 MB per entry, ≤ 200 entries per channel lane.
- Exceeding a cap fails the write — keep working data lean; don't stuff megabytes into the dictionary.

**Backpressure & guaranteed completion.** KeenAgents is tuned to **finish every accepted task, not to be the
fastest**. Once a run is accepted it always runs to an exit — it is never abandoned mid-run. So under load the
platform never drops accepted work: node executions are handled as a pool (about **16 in flight per instance**
by default), and when one instance nears its memory budget (~80–85%) it stops taking **new** work and its peers
absorb it. If an instance is momentarily saturated, a node dispatch is **refused at admission** (a retryable
`E4001` — it can hit any node of a run, not only the first) and the platform **retries** it transparently
(you don't handle this) until a slot frees, which is why a heavy fan-out paces itself rather than running
literally all at once. The one thing you feel under load is a
**slightly slower first token**, never a lost run.

A **sandbox runs a single instance** of each part, so heavy load there shows up as visible waiting; **production
scales out** across many instances (rough peak ≈ *instances × ~16 node executions in flight*), so the same load
just spreads. Either way the model is the same: peak degrades into a short retry, never a dropped task.

There is no "just make it bigger" knob — **design within these limits** (chunk data, page through APIs,
keep the dictionary lean).

---

## Why wrap risky work in try/catch (Scripts)

In a Script, an **uncaught throw sends the flow out the Error edge and rolls back all the dictionary writes
this script made** (all-or-nothing). That's often *not* what you want. Wrap the risky parts so you can
**handle** the failure — return a clean result, log it, and let the flow continue on **Out**:

```js
import Http from 'system/http';
import Log from 'system/log';
export const exec = async (props) => {
    try {
        const r = await Http.getJson(props.url);   // throws on timeout/SSRF/transport
        if (!r.ok) { Log.warning(`API ${r.status} for ${props.url}`); return { ok: false }; }
        return { ok: true, data: r.body };
    } catch (e) {
        Log.error(`fetch failed: ${e.message}`);
        return { ok: false, error: String(e) };   // dictionary writes above are preserved on a clean return
    }
};
```

Things that **throw** and deserve a try/catch: `system/http` (transport/timeout/SSRF/buffer), `JSON.parse`,
any code that can hit `E_SAB_BUSY`/`E_SAB_OVERFLOW`, and your own `throw`s. Deciding *when* to let it hit
the Error edge vs. catch-and-continue is a real design choice — catch when you can recover or want a clean
signal; let it throw when a downstream **Error** handler node should take over.

## Why use the logs

**Production has no debugger** — the flow/script debuggers are **sandbox-only** (see
`extension/debugging.md`). So in production the **logs are your only window** into what a flow did. Use
**`system/log`** (`info` / `warning` / `error` / `debug`) to record the decisions and failures that matter:

```js
import Log from 'system/log';
Log.info(`resolved user ${props.userId}, calling billing`);
Log.error(`billing rejected: ${r.status}`);
```

Log **the branch you took, the external call and its status, and every caught error.** When a colleague
asks "why did the agent do X in prod", the logs are the answer — if you wrote them.

## When your code is "invalid"

A Script fails (or a project is rejected) when:
- **No `exec` export** — a script must `export const exec = (props) => {…}`. Missing it → Error edge.
- **Syntax error** in the `.js` → it can't compile → Error edge.
- **A forbidden import** — anything that isn't a `system/*` module or a relative `./`/`../` file of your
  own (no npm packages, no absolute paths) → throws. (`node:crypto` `createHash`/`randomBytes`/`createHmac`/
  `getHashes` and `node:util` `TextEncoder`/`TextDecoder`/`URL`/`URLSearchParams` pass the deploy scan but
  are **refused at runtime** → Error edge; use `system/tools` / `system/http`.)
- **A forbidden identifier** — the deploy security scan rejects the **whole upload** (critical) if any
  `.js` calls `eval` / `Function` / `require` / dynamic `import()`, references `process`, `global`,
  `globalThis`, `module`, `exports`, `__dirname` or `__filename`, reads `constructor` / `prototype` /
  `__proto__` (or the `__define*` / `__lookup*` / `getPrototypeOf` / `setPrototypeOf` family) off a
  variable, reads `__proto__` off anything, assigns to any of those names, or uses `with`. See
  `nodes/script-node.md` → *What the deploy scanner rejects*.
- **A non-cloneable return** (a function, a class instance) → the copy-out throws → Error edge.
- **Naming / structure** — flows must be PascalCase `*.flow` at the top of `src/flows/`. A bad name is
  flagged by the **extension** (Problems panel; the panel's Connect / Upload stay disabled while errors
  exist) — the server-side deploy scan does **not** check names. What the **server** rejects (reason in
  Output ▸ Flow Builder): an empty `flows/`, a `.flow` that isn't valid JSON, or a security-scan hit. See
  `extension/project-and-files.md`.

## Settings + cookies together (e.g. a Google integration)

Three different stores, three different audiences — combine them for an integration:

| Store | Who reads it | Put here… |
|---|---|---|
| **Json Settings** | **your Scripts** (`system/settings`) | server-side config **and secrets** — e.g. the app's Google **client secret**. Never exposed to the browser. |
| **Front Settings** | the **partner's website** (the front end) | public config the site needs — e.g. the **client id** / redirect used to *start* the OAuth flow. |
| **cookies** | **your Scripts** (`system/cookies`) | the **per-user** value the browser holds — e.g. the **OAuth token** after the user consented. |

**Why split them?** Secrets must stay server-side (Json Settings → scripts only), the browser needs its own
public config (Front Settings), and the per-user token is inherently per-request (cookies). A **Google
integration** ties all three together:

1. The partner site reads **Front Settings** to start Google's consent flow.
2. The user consents → the browser ends up holding a **token cookie**.
3. A **Script** reads that token with `system/cookies`, reads the **client secret** from **Json Settings**
   with `system/settings`, and calls the Google API with `system/http` — wrapped in **try/catch**, with
   **logs** on each step.

That's the pattern: **credentials in Json Settings, the user's token in the cookie, public start-up config
in Front Settings** — never mix a secret into Front Settings (the browser would see it).

## Speech-to-text is the client's job, not the platform's

If you want voice input, note that **speech-to-text is a function of the client website** (the chat widget
converts speech → text and sends **text**), **not** of the Keen platform. Flows and agents only ever
receive **text** — don't build a flow expecting to do STT; the partner's front end does it before the
message reaches the agent.

---

## LLM resilience — wire a 2–3 level model fallback

An Agent (LLM) node's **Fallback** (`error`) edge is your model-failover switch: when the chosen provider
is down, rate-limited, or throwing, route the **same turn to another agent node on a different provider**
so the user still gets an answer. **Two to three levels is enough** — primary → a different-provider spare
→ an optional cheap `…-flash` / `…-mini` — and the **last level must degrade gracefully**: a fixed, human
*"the assistant is temporarily unavailable, please try again shortly,"* never a raw provider error or a
dead-end. Use **different providers** across levels (a provider outage or a bad key takes out all of that
provider's models at once). Full pattern: `nodes/agent-node.md` → *Fallback — model failover (2–3 levels)*.

## Troubleshooting — common symptoms & causes

| Symptom | Most likely cause / fix |
|---|---|
| **The agent says "No tool response" (or "the tool isn't returning any data") — but the tool clearly ran and fetched data.** | The tool pushed its result **without the agent's `sessionID`**. The agent resolves its trigger **scoped to its own session**, so a push without `sessionID: toolOptions.agentNode.flowContext.sessionId` is invisible to it. Stamp every `Agent.setRootAgentPrompt(agentId, { prompt, … })` with `sessionID: toolOptions.agentNode.flowContext.sessionId` (and a fresh `requestID` via `Tools.generateUUID()`). This is the **#1 tool bug** — see `tool-calling.md` §4. |
| **The agent never calls a tool** even though it's registered. | (a) The **System prompt** doesn't teach the `<SYSTEM CALL>` format + tool catalogue (the engine doesn't generate them — `tool-calling.md` §5). (b) **"Use tools" is OFF** on the LLM node. (c) The tool `name` in the catalogue ≠ the `name` in `keen-tools.json`. |
| **"The requested tool does not exist."** | `!*tool` name doesn't match a `keen-tools.json` entry, **or** the project wasn't **re-deployed** (the registry compiles at deploy). Re-upload. |
| **The agent silently never runs at all.** | The agent's **Start Flow / Start Node** (admin) don't **exactly** match a real flow file + start-node label in the deployed project (`E5001`). PascalCase, exact. |
| **A Script node fails to the Error edge unexpectedly.** | No `exec` export / syntax error / a forbidden import (only `system/*` + relative `./` files) / a non-cloneable return. Check **Output ▸ Flow Builder** and `system/log`. |
| **`E_SAB_BUSY` / `E_SAB_OVERFLOW` from a script.** | You fired two `system/http`/`system/agent` reads at once (`Promise.all`) or got a response bigger than the ~10 MB buffer. **`await` reads one at a time.** |
| **`E5001` "entry not found" from a Run/Jump/Parallel.** | The `File-Label` target doesn't exist in the deployed project (typo, wrong file/label, or not deployed). |
| **A Condition throws "Member access is not allowed".** | You wrote a **bare** `dictionary.x` in the expression. Wrap the reference: `${dictionary.x} > 25` (`nodes/condition-node.md`). |
| **A Loop throws "invalid value/setto".** | `Read from` / `Set to` need the root prefix — `dictionary.<path>` or `session.<key>`, not a bare name (`nodes/loop-node.md`). |
| **A number compares wrong (e.g. `${dictionary.n} > 25` always false).** | An **Assignment** stored `"25"` as a **string** (no coercion). Store real numbers via a placeholder that resolves to a number, or coerce in a script (`nodes/assignment-node.md`). |
| **In production, "why did the agent do X?" and there's nothing to see.** | Production has **no debugger** — add `system/log` calls now (the branch taken, each external call + status, every caught error). Those lines can then be **captured and streamed live** by turning on a **Log Record** for the space/agent (admin console → Logs) — so they *are* your prod window now. See `observing-your-flow.md`. |

## A note on the partner site (entanglement)

The reference partner website that connects to an agent (an example integration boilerplate) is a separate
project. **It's covered in its own guide, not here** — this folder is about building the flows and agents
themselves, not the partner site that talks to them.

---

*Node details: `nodes/script-node.md`, `nodes/agent-node.md`. Stores: `data-model.md`. Tools:
`tool-calling.md`.*
