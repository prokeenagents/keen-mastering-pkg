# Seeing what your flow does — logs & live monitoring

You've built a flow and deployed it. Now the question every builder hits: **what did it actually do at
runtime** — which branch did it take, what did that external call return, why did it fall to the Error edge?

A live run is a black box until you open it. You have two windows:

- **On a sandbox, while debugging** — the debugger (breakpoints, step through nodes). See
  `extension/debugging.md`.
- **On any live run (including production)** — the log lines your scripts write with **`system/log`**, which
  the platform can now **stream live** to whoever is watching, and store. That's this page.

> This closes the old gap. It used to be that production had no window at all — you added `system/log` calls
> and hoped someone could read the server. Now those same lines can be turned into a **live stream** and a
> stored log, per space or per agent, with no server access. Your job as the builder is simply to *log the
> things that matter*; turning the stream on is one switch in the admin console.

---

## 1. Log from a script — `system/log`

Inside any Script node's `exec`, import the logger and call one of its four levels. (Verified against the
engine: the API is exactly these four — there is no `Log.log`.)

```js
import Http from 'system/http';
import Log from 'system/log';

export const exec = async (props) => {
    Log.info(`resolved user ${props.userId}, calling billing`);

    let result;
    try {
        result = await Http.getJson(`https://api.example.com/billing/${encodeURIComponent(props.userId)}`);
    } catch (e) {
        Log.error(`billing unreachable: ${e.message}`);   // the failures that matter
        return { ok: false };
    }

    if (!result.ok) {
        Log.warning(`billing soft-failed: ${result.status}`);
        return { ok: false };
    }
    Log.debug(`raw payload: ${JSON.stringify(result.body)}`);
    return { ok: true };
};
```

| Level | Use it for |
|---|---|
| `Log.error(msg)` | a real failure — a caught exception, a rejected call, a branch you never want to hit |
| `Log.warning(msg)` | a soft failure / fallback you took (a retry, a default value) |
| `Log.info(msg)` | the decisions that explain the run — the branch chosen, each external call + status |
| `Log.debug(msg)` | detail you only want when digging — raw payloads, intermediate values |

`msg` is a string. Pass an object and it's JSON-stringified for you. Log the **branch taken**, **every
external call and its status**, and **every caught error** — see `best-practices.md`.

What can log: any **Script node** (the four levels above). Logs are tagged with the **space and agent** the
run belongs to, which is how a Log Record (below) finds them.

---

## 2. Turn the logs on — a **Log Record**

Your `Log.*` lines are only captured if someone has turned on a **Log Record** for your work. That's an admin
action in the console (the **Logs** section), and it takes one decision — **how wide**:

- **Agent** — capture the logs of **one agent**. Use this while iterating on a single agent's flow.
- **Space** — capture the logs of **every agent in the space**. Use this for a whole product's traffic.

(An agent-scoped record wins over a space-wide one for that agent — the most specific record decides.) A
record can be **Emitting** (on) or **Paused** (off) without deleting it.
<!-- UNVERIFIED (audit 2026-09-12): the Emitting/Paused wording, the agent-over-space precedence and the
"stream token" below are admin-console behaviour that could not be checked against the engine code; only
the (space, agent) scoping of log records is confirmed in ms-logs. -->



You don't have to be the admin to benefit — ask whoever runs the console to add a Log Record for your space
or agent, then your log lines start flowing the next time the flow runs.

---

## 3. Watch it live

Once a Log Record is Emitting, the log lines can be **streamed live** — an admin watching in the console, or a
partner site the admin has granted a **stream token**, sees each `Log.*` line the moment your flow writes it,
and the lines are stored so they can be read back later. No server access, no waiting.

For you the builder, that means the debugging loop no longer stops at the sandbox:

```
edit the flow/script  →  deploy  →  prompt the agent  →  watch your Log.* lines live  →  fix  →  repeat
```

The logs are your narration of the run. A flow that logs its branch, its calls, and its errors is one you can
actually debug in production; a silent flow is a black box again. Log deliberately.

---

## See also

- `best-practices.md` — *what* to log (and the other habits that make a flow debuggable).
- `extension/debugging.md` — the sandbox debuggers, for stepping through a run while you build.
- `flow-lifecycle.md` — what happens to a run from start to exit.
- The admin console's **Logs** section — where a Log Record is created and where the live stream is watched.
