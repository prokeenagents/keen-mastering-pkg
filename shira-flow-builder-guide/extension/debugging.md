# Debugging — flow debugger & script debugger

Shira ships **two** debuggers, for the two kinds of code you write: **flow** (the node graph) and **script**
(the JavaScript in a Script node). They work differently.

> **Debuggers are a SANDBOX-only feature.** They attach to a **sandbox** environment. A
> **production** environment does **not** expose them (a sandbox is a single, non-scaling dev environment —
> it's not a production deployment). Debug on a sandbox; ship to prod without debuggers.

Both need the project **deployed** first (Connect → Upload — see `the-panel.md` — or `keen-deploy`),
because you're debugging the code as it **runs on the sandbox**, not locally. The debuggers live in the
VS Code extension; without it, read the run through its logs (`../observing-your-flow.md`) and `run.ts`.

---

## Before you debug — the switch, the permission, your login

Every debugger connection is signed in with **your own console account**. Three things must hold:

1. **The debugger is switched ON.** It is **off by default**. The organization's **owner or an admin**
   switches it on (and off) on the console's **Debugger** page (System group). While it is off, every
   connection is refused; switching it off closes the open sessions and resumes paused runs. Anyone with the permission below sees on that page
   whether it is on.
2. **Your role has the Debugger permission** (scope `debug`, read only — see the admin guide's
   `14-limits-and-scopes.md`). The owner and admins have it by role. Only a person's console account can
   debug — an MCP account never can.
3. **`.vscode/keen.json` carries your login** — `user` (the e-mail you sign in to the console with) and
   `password`, next to `server`, `space` and `token` (see `project-and-files.md`). The file is a local
   secrets file: keep it **git-ignored** and never commit it.

**The extension signs in and connects for you.** On Start Flow Debugger / Start Script Debugger it signs in
with `user` + `password`, gets a one-time debug ticket (one connection, valid for 5 minutes), signs out
again, and attaches. Every start does this again — there is nothing to refresh by hand.

**Two-step sign-in.** When your console account has two-step sign-in (an authenticator app or an e-mailed
code), the extension — **0.0.6 or newer** — asks the 6-digit code in a box after the password, on every
start: from your app, or from the e-mail (*Send a new code* mails another). A wrong code is refused like a
wrong password. *Set up two-step sign-in in the console first* means your organization requires it and your
account has none yet: set it up in the console (avatar menu → **Account** → **Security**), then start again.
An extension older than 0.0.6 cannot sign in such an account. The code is never written to `keen.json` or
the log.

**Where it attaches.** The extension first probes the server's TLS edge on port 443 —
`https://<server>/keen-debug/flow/dbg/<ticket>` and `wss://<server>/keen-debug/script/dbg/<ticket>/ws`, so only
port 443 has to be reachable. If the server has no edge (the probe is answered by a redirect, a 404 or a web
page) it falls back to the debugger ports `7101` (flow) and `7100` (script) on the host in `keen.json` —
`debugHost` when you set it, else the `server` host. Some servers publish no debugger ports at all; there
only the edge works.

**Attaching by hand** (another client, or a hand-written `launch.json`): the toolkit's
`agent-runner/debug.ts --kind=flow|script --project <your project>` prints the same one-time address —
`https://<server>/keen-debug/flow/dbg/<ticket>` (or `http://<host>:7101/dbg/<ticket>` on a server without the edge) for the flow
debugger, and for the script debugger `wss://<server>/keen-debug/script/dbg/<ticket>/ws` (or `ws://<host>:7100/dbg/<ticket>/ws`) plus a ready
`launch.json` configuration (`agent-runner/docs/DEBUG.md`).

**The debugger belongs to one space.** The ticket carries the `space` from `.vscode/keen.json` (a real
space id is required for both debuggers): a breakpoint stops only runs of that space, and only the scripts /
flow nodes it is set on. Every other run runs normally, and `debugger;` statements stop only in such a run.
One debugger window per kind at a time — a second one is closed with *Debugger in use*.

If the start is refused: *bad credentials* → check `user` / `password`; *Forbidden* → your role lacks the
Debugger permission (ask the owner or an admin); *Debugger is off* → ask the owner or an admin to switch it on; *Space not found* → check `space` in `keen.json`; *Sign-in cancelled — no two-step code was entered* → start again and enter the code.

---

## Flow debugger — breakpoints on nodes

**What it does:** pauses when a **flow node** you marked is about to run, and lets you inspect the
`dictionary` and `session` at that point.

**How to use it:**
1. Make sure the debugger is switched on and your `keen.json` has your login (above).
2. **Deploy** your project.
3. Open a `.flow` in the canvas, **select node(s), and press `F9`** to toggle a breakpoint on each (they
   appear in the **Breakpoints** view). Breakpoints are stored by the extension — they are **not** written
   into the `.flow` file.
4. Click **Start Flow Debugger** (the debug icon in the `.flow` editor's title bar). It attaches to the
   sandbox (the `server` in `keen.json`, through the edge or the ports).
5. **Trigger the flow** (send a chat message / run it). Execution **pauses** the moment a breakpointed node
   runs — the node lights up on the canvas.
6. **Inspect**: the Variables panel shows **Dictionary**, **Session**, and **globalThis** — expand to read
   the values the flow holds right now. **Continue** runs to the next breakpointed node.

**What it is NOT:** there's **no line-by-line stepping** here — the unit is a **node**. "Continue" and
"step" both mean *run to the next breakpointed node*. (For line stepping, that's the script debugger.)

---

## Script debugger — line breakpoints in `.js`

**What it does:** a normal **Node.js** debugger for the JavaScript in your `scripts/*.js` files — real
**line breakpoints**, stepping, and variable inspection.

**How to use it:**
1. Make sure the debugger is switched on and your `keen.json` has your login (above).
2. **Deploy** your project.
3. Open a `scripts/*.js` file and set ordinary **line breakpoints** (click the gutter).
4. Click **Start Script Debugger** (the debug icon in the `.js` editor's title bar). It attaches a Node
   debugger to the sandbox, mapping your local `src/` to the deployed code so your
   breakpoints bind. (It needs a real `space` in `.vscode/keen.json` — the deployed code lives under that
   id, and it is the only space the debugger stops in — and refuses with a warning otherwise.)
5. **Run a flow whose Script node executes that file.** Execution stops on your line; **step**, inspect
   locals (`props`, `dictionary`, …), and continue like any Node debug session.

**How it differs from the flow debugger:** this is a **standard source-level** debugger — line breakpoints,
full stepping, source maps, and path mapping — versus the flow debugger's **node-level** breakpoints and
"run to next node" stepping.

---

## While you are paused — what ends a session

- **15-minute auto-resume.** A run that stays paused at the **same point** for 15 minutes is resumed
  automatically — whether or not a debugger is still attached — so a forgotten breakpoint never holds the
  sandbox. Any step or continue restarts the 15 minutes.
- **One hour per debugged run.** A run that is being debugged is stopped after one hour in total, however
  often you step (the chat answers the terminal `E8001`). A debugged script is exempt from the 15-minute
  Script-node limit, not from this one.
- **Kill debugger connections and resume.** The owner or an admin can press it on the console's Debugger
  page: it ends **every** debug session and resumes every paused run at once, without switching the
  debugger off.
- **A session also ends** when the debugger is switched off, when the Debugger permission is removed from
  your role, or when your password changes. Start the debugger again to reconnect (once you have access).

---

## Which one do I want?

- **"My flow takes the wrong path / the dictionary looks wrong at a node."** → **Flow debugger** (F9 on
  nodes, inspect Dictionary/Session).
- **"My Script node's code is misbehaving."** → **Script debugger** (line breakpoints in the `.js`).

Remember: **deploy first**, and **sandbox only**.

*Panel & deploy: `the-panel.md`. Project files: `project-and-files.md`.*
