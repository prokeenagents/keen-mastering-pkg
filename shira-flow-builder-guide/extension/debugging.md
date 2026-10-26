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

## Flow debugger — breakpoints on nodes

**What it does:** pauses when a **flow node** you marked is about to run, and lets you inspect the
`dictionary` and `session` at that point.

**How to use it:**
1. Make sure the sandbox has flow debugging enabled.
2. **Deploy** your project.
3. Open a `.flow` in the canvas, **select node(s), and press `F9`** to toggle a breakpoint on each (they
   appear in the **Breakpoints** view). Breakpoints are stored by the extension — they are **not** written
   into the `.flow` file.
4. Click **Start Flow Debugger** (the debug icon in the `.flow` editor's title bar). It attaches to the
   sandbox (derived from `keen.json`'s `server` host).
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
1. Make sure the sandbox has script debugging enabled.
2. **Deploy** your project.
3. Open a `scripts/*.js` file and set ordinary **line breakpoints** (click the gutter).
4. Click **Start Script Debugger** (the debug icon in the `.js` editor's title bar). It attaches a Node
   debugger to the sandbox, mapping your local `src/` to the deployed code so your
   breakpoints bind. (It needs a real `space` in `.vscode/keen.json` — the deployed code lives under that
   id — and refuses with a warning otherwise.)
5. **Run a flow whose Script node executes that file.** Execution stops on your line; **step**, inspect
   locals (`props`, `dictionary`, …), and continue like any Node debug session.

**How it differs from the flow debugger:** this is a **standard source-level** debugger — line breakpoints,
full stepping, source maps, and path mapping — versus the flow debugger's **node-level** breakpoints and
"run to next node" stepping.

---

## Which one do I want?

- **"My flow takes the wrong path / the dictionary looks wrong at a node."** → **Flow debugger** (F9 on
  nodes, inspect Dictionary/Session).
- **"My Script node's code is misbehaving."** → **Script debugger** (line breakpoints in the `.js`).

Remember: **deploy first**, and **sandbox only**.

*Panel & deploy: `the-panel.md`. Project files: `project-and-files.md`.*
