# Script Node

**Palette name:** `Script`  ·  **Dots:** **In** (`in`) · **Out** (`next_1`) · **Error** (`error`)  ·
**Settings:** Script path (required), Label, Dictionary Key/Value Pairs (props), Description

**In one line:** runs a **custom JavaScript file** from your project — it gets `props`, can read/write the
`dictionary` and `session`, call agents, log, fetch over HTTP, and returns down **Out** (or **Error** if
it throws).

> Base controls (drag handle, **Settings** toggle, **Rotate**, two-level **Save**, **170px** card,
> **16px** snap) are as on Start — see `start-flow-node.md`. The data stores are in `../data-model.md`.

---

## What it is / what it's for

A **Script** node runs a `.js` file you wrote (in the project's `scripts/` folder) inside a secure
sandbox (an isolated V8 — no filesystem, no ambient network; capabilities come only through the
`system/*` imports below). Use it for logic that flows can't express with the other nodes: shaping data,
calling an external API, driving agents programmatically, custom validation.

## The script file — the required shape

**Every script must export a function named `exec` that takes one argument, `props`:**

```js
export const exec = (props) => {
    // your code
    return { ok: true };   // the return value becomes the node's result (must be JSON-cloneable)
};
```

- It's a **named export** called **`exec`** (not `export default`). If a script doesn't export an `exec`
  function, the node fails to the **Error** edge.
- It may be **sync or `async`** — `export const exec = async (props) => { … }` works; the engine awaits
  the result.
- The **return value** becomes the node's result and must be **structured-cloneable** (plain
  data — no functions/classes). A returned object is copied out of the sandbox.

## On the canvas — three dots

| Dot (label) | Handle id | Direction | Wire it to… |
|---|---|---|---|
| **In** (top) | `in` | input | the previous node |
| **Out** (bottom) | `next_1` | output | what runs on a **clean return** |
| **Error** (side) | `error` | output | what runs if the script **throws** |

## Settings

| Field | Required | What it is |
|---|---|---|
| **Script path** | **yes** | `data.settings.value` — the **`.js` file** in the project's `scripts/` folder (e.g. `init.js`, or `lib/init.js` in a sub-folder). |
| **Label** | recommended | display name (`data.settings.label` + `data.label`). |
| **Dictionary Key/Value Pairs** | no | `data.settings.keyValuePairs` — the **`props`** passed to `exec` (see below). Same editor as the Assignment node, but the values arrive as `props`. |
| **Description** | no | a plain note. |

## `props` — the inputs to `exec`

The Key/Value Pairs are resolved with the **same `${...}` rules** as everywhere (only `${dictionary.*}`
and `${session.*}`, see `../data-model.md`) and handed to `exec` as an object:

```jsonc
// settings.keyValuePairs
[ { "key": "propOne", "value": "123" },
  { "key": "userName", "value": "${dictionary.name}" } ]
```
```js
export const exec = (props) => {
    props.propOne;   // "123"  — ⚠ a bare literal stays a STRING (no "123"→123 coercion)
    props.userName;  // the value of dictionary.name (type preserved if it's a whole-string placeholder)
};
```

> Same coercion caveat as Assignment: `"123"` arrives as the string `"123"`. To pass a real number, use a
> placeholder resolving to a number (`"${dictionary.count}"`), or `Number(props.propOne)` inside the
> script.

## The data a script can touch

### `dictionary` — a bare global (current flow's scratchpad, **writable**)

`dictionary` is available directly (no import) — it's a **mutable copy of the current flow's
dictionary**. Read it, mutate it; on a **clean return** your changes are diffed and committed back.

```js
export const exec = (props) => {
    const items = dictionary.items ?? [];      // read
    dictionary.count = items.length;           // write — persists on clean return
    dictionary.summary = { first: items[0] };  // nested is fine (dictionary is nested JSON)
};
```

### `session` — via `import Session from 'system/session'` (whole-run, flat)

The session is **not** a bare global; import it. It's the **whole-run shared** store — **flat primitives
only** (string/number/boolean/null). See `system/session` below.

### everything else — through the `system/*` imports (next section)

Also available as bare globals (rarely needed): `flowContext` (this call's identity ids) and, inside a
tool flow only, `toolOptions`. Do **not** touch `__host` — it's an internal bridge.

---

## The `system/*` imports — full reference

Import a resource by its module name. **Both styles work** — a default import of the whole object, or
named imports of individual methods:

```js
import Log from 'system/log';        Log.info('hello');
import { info } from 'system/log';   info('hello');
```

There are **nine** resources (note: it's `system/log`, **singular** — not `system/logs`):

### `system/log` — write to the audit/log stream
`import Log from 'system/log'` → `error(msg)`, `warning(msg)`, `info(msg)`, `debug(msg)`. A non-string
`msg` is JSON-stringified. The host prefixes every line with the **flow file name** the node belongs to
(`Project.flow | …`) and tags it with the run's space + agent.
**Use:** leave a trace in the platform logs. *Not* shown to the end user.
```js
import Log from 'system/log';
export const exec = (props) => { Log.info(`processing ${props.userName}`); };
```

### `system/chat` — stream interim status to the end user
`import Chat from 'system/chat'` → `writeOut(msg)`, `writeThinking(msg)`, `writeError(msg)`,
`writeAgentProgress(subSessionId, current, total, msg)`, `writeAgentStream(subSessionId, content,
isPartial)`, `writeAgentStart(mainSessionId, subSessionId, agentName, flowEntry)`,
`writeAgentEnd(subSessionId, status, result, duration)`, `writeFiles(files)`.
**Use:** show the user a live "what I'm doing now" message. `writeOut` is an **interim** message — it is
**not** the final answer (the node's return / the agent's response is).
```js
import Chat from 'system/chat';
export const exec = (props) => { Chat.writeOut('Fetching your order…'); };
```

### `system/session` — the whole-run shared KV
`import Session from 'system/session'` → `setSessionValue(key, value)`, `getSessionValue(key)`,
`deleteSessionValue(key)`, `clearSessionStorage()`, `hasSessionKey(key)`, `getSessionSize()`. It's also a
**Proxy**, so direct property access works: `Session.userId` (read), `Session.userId = 'x'` (write).
**Flat primitives only.** **Use:** share small values across every flow in the run (a flag, an id).
```js
import Session from 'system/session';
export const exec = (props) => {
    Session.setSessionValue('lastStep', 'validated');
    const step = Session.getSessionValue('lastStep');  // or: Session.lastStep
};
```

### `system/dictionary` — read **another** flow's dictionary
`import Dict from 'system/dictionary'` → `get({ flowID, path })` (read a value from another flow's dict,
read-only), `closeDictionary(flowID)` (delete another flow's whole dict). **The current flow's dict is
the bare `dictionary` global — this resource is for cross-flow reads.**
```js
import Dict from 'system/dictionary';
export const exec = (props) => { const v = Dict.get({ flowID: props.otherFlow, path: 'result' }); };
```

### `system/agent` — the agent conversation (prompts & responses) — see the deep section below
`import Agent from 'system/agent'` → 19 methods for reading/writing the agent channels
(`getRootAgentPrompt`, `getAgentLastResponse`, `getChannelResponses`, `setRootAgentPrompt`,
`setAgentResponse`, `deleteChannel`, …). **Use:** drive agents from a script and read their answers.

### `system/settings` — read the agent's Json Settings
`import Settings from 'system/settings'` → `get(fieldId)`, `getMany(...fieldIds)`, `has(fieldId)`.
Read-only. **Use:** read config a human set on the agent's **Json Settings** page.
```js
import Settings from 'system/settings';
export const exec = (props) => { const model = Settings.get('preferredModel'); };
```

### `system/cookies` — read the request's browser cookies (read-only)
`import Cookies from 'system/cookies'` → `get(name)`, `all()`, `has(name)`.
**Use:** read a token the user's browser sent (e.g. an OAuth cookie) to call a 3rd-party API.

### `system/http` — make an outbound HTTP call (the isolate has no network of its own)
`import Http from 'system/http'` → `get(url, opts?)`, `getJson(url, opts?)`, `post(url, body, opts?)`,
`postJson(url, json, opts?)`, `request({ url, method, headers, body })` — `opts.headers` sets request
headers on the four helpers. **Every method returns `{ ok, status, body }`** — an HTTP *error status* comes
back as `{ ok:false, status }` (check `ok`), but a **transport/policy failure** (network error, **timeout**
— 15 s by default, more than 3 redirects, blocked scheme/**SSRF**, or a buffer error — see below)
**throws** → wrap the call in **try/catch**. **Use:** call an external API.

> **One buffer op at a time.** `system/http` **and** `system/agent` reads share a single ~10 MB buffer, so
> only one may run at once. Firing two together (`await Promise.all([Http.getJson(a), Http.getJson(b)])`,
> or an un-awaited call) throws **`E_SAB_BUSY`**; a response larger than the buffer throws
> **`E_SAB_OVERFLOW`**. So **`await` each HTTP/agent read one at a time** — don't parallelise them.
```js
import Http from 'system/http';
export const exec = async (props) => {
    const r = await Http.getJson(`https://api.example.com/u/${props.userId}`);
    if (!r.ok) { /* handle */ }
    dictionary.profile = r.body;
};
```

### `system/tools` — small host utilities
`import Tools from 'system/tools'` → `generateUUID()` (the sandbox has no `crypto`), `getTimestamp()`
(`Date.now()`). **Use:** a unique id / a timestamp.

> Anything else (`import x from 'lodash'`, absolute paths, `system/connectors/*`, or non-ported
> resources like `system/flow`) is **forbidden** — the import throws to the Error edge.

---

## Importing one script from another

Scripts can import your **own** files by **relative path** — and yes, from another folder:

```js
// scripts/init.js
import { clean } from './helpers.js';         // same folder
import { format } from '../lib/format.js';    // a sibling folder
export const exec = (props) => { return format(clean(props.raw)); };
```

- Only **relative** specifiers (`./…`, `../…`) are allowed for your files; they resolve **relative to the
  importing script** and are read from your project (so `../lib/format.js`, `../../common/x.js` all work
  as long as they exist in the project).
- An imported helper file is a **normal module** — it exports functions/constants; it does **not** need an
  `exec` (only the node's **entry** script does).
- **Not allowed:** bare package names (`'lodash'`) and absolute paths — only `system/*` and your own
  `./relative` files.

---

## What the deploy scanner rejects (the script never gets to run)

Every `.js` under `src/` is statically scanned at upload; one **critical** hit rejects the **whole**
upload (the reason lands in Output ▸ Flow Builder). Beyond the import rules above, the scanner forbids:

- calls to `eval(…)`, `Function(…)`, `require(…)`, and dynamic `import(…)`;
- any reference to `process`, `global`, `globalThis`, `module`, `exports`, `__dirname`, `__filename`;
- reading `constructor`, `prototype`, `__proto__` (or the `__defineGetter__` / `__lookupGetter__` /
  `getPrototypeOf` / `setPrototypeOf` family) off a variable (`dictionary.constructor`,
  `obj['prototype']`), reading `__proto__` off anything, or **assigning** to any of those names on any
  object — a rejection at upload, not a runtime error;
- a `with` statement. (A `debugger` statement is only flagged, not blocked.)

`node:crypto` (`createHash`, `randomBytes`, `createHmac`, `getHashes`) and `node:util` (`TextEncoder`,
`TextDecoder`, `URL`, `URLSearchParams`) named imports **pass the scan but are refused at runtime** by the
script resolver → Error edge. Use `system/tools` (`generateUUID`) and `system/http` instead.

---

## Agent communication: channels, SessionMgr, getting an agent's answer

This is how a **script** talks to **agents** (and how the pieces the user asked about fit together).

### What a "channel" is

Agents don't message each other directly — they pass messages through the **agent-state store**, which is
organised as **channels**. There are two documents per run — a **prompts** store and a **responses** store —
each shaped `{ agentId: { channel: [newest-first, …] } }`. A **channel** is just a named lane; the default is
**`'root'`**. Channels let you run several parallel sub-conversations without mixing them (e.g. a
`questions` lane and an `answers` lane).

### Sending a message to an agent (so an Agent node will pick it up)

`Agent.setRootAgentPrompt(agentID, { prompt, channel, sessionID, requestID })` writes a **user** message
(it bakes `role:'user', agentChat:true`) onto a channel; an **Agent** node reading that channel takes it
as its trigger. **Always stamp `sessionID` with the *target* agent's session** — the agent resolves its
trigger scoped to its own session first, so an un-stamped push is the #1 silent tool bug
(`../gotchas.md` A1/A2): inside a tool flow that is `toolOptions.agentNode.flowContext.sessionId`; for an
Agent node later in *this* flow it is the bare `flowContext.sessionId`. Mind the capital `ID` on the
write keys.

```js
import Agent from 'system/agent';
import Tools from 'system/tools';
export const exec = (props) => {
    Agent.setRootAgentPrompt('offer-agent', {
        prompt: `Summarise: ${props.text}`,
        channel: 'com',
        sessionID: flowContext.sessionId,      // the target agent's session (tool flow: toolOptions.agentNode.flowContext.sessionId)
        requestID: Tools.generateUUID()
    });
};
```

### Getting a response **back** from an agent

After the agent runs (its answer is always mirrored to the **responses** store on the trigger's channel), read it:

```js
import Agent from 'system/agent';
export const exec = (props) => {
    const last = Agent.getAgentLastResponse('offer-agent');        // newest response (root channel)
    const onCom = Agent.getChannelResponses('com');                // all responses on the 'com' lane
    const byReq = Agent.getAgentLastResponseByRequestId('offer-agent', props.requestId);
    // consumeChannelResponses('com') reads AND clears the lane (drain), if you want each answer once
};
```

Full method set on `Agent`: reads — `getRootAgentPrompt`, `getAgentLastPrompt`, `getAgentLastResponse`,
`getAgentLastResponses`, `getAgentLastResponseByRequestId`, `getAgentLastResponseBySessionId`,
`getAgentResponseBySessionRequestIds`, `getChannelPrompts`, `getChannelResponses`; drains —
`consumeChannelPrompts`, `consumeChannelResponses`; writes — `setAgentPrompt`, `setAgentResponse`,
`setRootAgentPrompt`; deletes — `deleteChannel`, `deleteAgentPrompts`, `deleteAgentResponses`,
`deleteAgentPrompt`, `deleteAgentResponse`.

### "SessionMgr"

The session manager a script uses **is `system/session`** (imported as `Session` above) — there is no
separate `SessionMgr` import. It's the **whole-run flat KV**: `Session.setSessionValue('k', v)` /
`Session.getSessionValue('k')` (or `Session.k`). Use it to carry a value between flows/nodes in the run;
use the **`dictionary`** global for per-flow working data, and **channels** (`system/agent`) for the
agent conversation.

---

## What happens on a clean return vs a throw

- **Clean return** → the `dictionary` changes are committed, `session` writes are committed, and any
  queued `Agent.set…` writes are flushed; the flow continues out **Out** with your return value.
- **Throw** → the flow goes out the **Error** edge, and:
  - **dictionary** changes are **discarded** (all-or-nothing — nothing is half-written),
  - queued **agent writes** are **discarded** too,
  - but **session** writes made before the throw **persist** (so an error-handler node can read them).

```js
export const exec = (props) => {
    if (!props.userId) { throw new Error('missing userId'); }  // → Error edge, dict rolled back
    dictionary.ok = true;                                      // committed only on clean return
    return { done: true };
};
```

## What a Script node looks like in the `.flow` file

```json
{
  "id": "scriptNode_RCIdVn2toQko",
  "type": "scriptNode",
  "position": { "x": 176, "y": 576 },
  "data": {
    "label": "My Script",
    "description": "This is a custom script execution",
    "labelNode": "Script",
    "descriptionNode": "Execute custom JS script",
    "open": true,
    "settings": {
      "value": "init.js",
      "label": "My Script",
      "keyValuePairs": [ { "key": "propOne", "value": "123" } ]
    }
  },
  "dragHandle": ".drag-handle__custom"
}
```

| Field | Value / rule | What it is |
|---|---|---|
| `id` | `scriptNode_` + **12** `A–Za–z0–9` | id; the `scriptNode_` prefix carries the kind |
| `type` | `"scriptNode"` | mandatory node kind |
| `data.settings.value` | the **script path** (`init.js`) | the `.js` file in `scripts/` to run |
| `data.settings.keyValuePairs` | `[{key,value},…]` | the interpolated `props` |
| `data.labelNode` | **fixed** `"Script"` | card title |
| `data.descriptionNode` | **fixed** `"Execute custom JS script"` | card subtitle |
| `dragHandle` | `".drag-handle__custom"` | fixed |

### Wiring (edges)

**In** from upstream; **Out** (`next_1`) for a clean return; **Error** (`error`) for a throw. Edges carry
`"type": "step"` + `{ id, source, sourceHandle, target, targetHandle }`. Wire the **Error** dot to a
handler if the script can fail — otherwise a throw just ends that branch.

## ⚠️ Watch out for

- **Must export `exec`** (named). No `exec` → Error edge.
- **`props` literals are strings** — coerce numbers yourself (`Number(props.x)`).
- **`system/log` is singular**, not `system/logs`; only the nine listed resources exist.
- **Only relative imports** for your own files; no npm packages, no absolute paths.
- **Wire the Error dot** for anything that can throw — dictionary/agent writes roll back on a throw.
- **`dictionary` writes commit only on a clean return** — a throw discards them.

## ⏱ Performance

Each run gets a fresh disposable sandbox with a hard cap of **~40 MB** (≈30 MB for your code + a shared
~10 MB buffer for HTTP/agent reads). The node's cost is your code plus any `system/http` calls; keep heavy
work and large returns in mind. The sandbox is torn down after each run.

---

*Next node: Agent / LLM (`agent-node.md`).*
