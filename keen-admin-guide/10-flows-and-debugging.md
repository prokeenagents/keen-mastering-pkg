# Flows & debugging

**In one line:** a flow is the step-by-step logic an agent runs. Authoring flows has its **own
dedicated guide** (`../shira-flow-builder-guide/README.md`). Here we cover only what this guide is
about: the fact that you *can* debug them, and where.

## Flows — just enough

A **flow** is the logic an agent follows: ask the model something, run a script, branch on a
condition, call another flow, answer. Agents start from a flow + a node (you set that when you create
the agent). You build flows in your project and then **deploy** them into a space
(`04-deploy-a-project.md`).

**Authoring flows is not covered here.** There is a separate, dedicated guide for the flow builder —
`../shira-flow-builder-guide/README.md`. If a colleague asks "how do I build a flow / what nodes are
there / how do I wire them," point them to that guide, not this folder.

## Debugging your agent

While you're building, you can **debug an agent's flows and scripts at the source level** — set a
breakpoint, run the agent, and step through your own code line by line, inspecting values as it goes,
from your IDE. It's the same experience as debugging any program, aimed at your flow/script logic.

### Where debugging is available — read this

- **Sandboxes have debuggers.** Every sandbox the platform renders — the development one and the
  production-shaped one alike — carries the flow and script debuggers. Your IDE reaches them over
  **HTTPS on the sandbox's own address** (no extra ports to open); the Keen VS Code extension
  **0.0.4 or newer** finds them by itself. Every connection is signed in with a person's own console
  account (below). Debugging is a build-time tool: don't assume a debugger is attached to an
  environment that serves real users.
- **A sandbox is a build-and-test environment, not the production version.** It is where you develop,
  try things, and debug — it is **not** meant to carry real production traffic, and it does **not**
  scale for it. Build and debug in a sandbox; serve real users from production.

### The Debugger page — who may debug, and when

The debugger is **off by default**. The console's **Debugger** page (in the **System** group of the
sidebar) is where that changes:

- **The switch (owner and admins only).** Turn the debugger **on** for the organization while people are
  debugging, **off** when they're done. Off means every debug connection is refused, and switching it off
  also closes the open sessions and resumes every paused run. The page shows who changed it last, and
  when.
- **Kill debugger connections and resume (owner and admins only).** One button, behind a confirmation:
  it ends **every** open debug session and resumes **every** paused run, without switching the debugger
  off — for the moment someone left a breakpoint holding a run and walked away. The result lists how many
  sessions were closed and runs resumed, per service. The action is recorded in the audit trail.
- **Everyone with the Debugger permission** sees the page too: whether the debugger is on, and how to
  connect from VS Code. Owners and admins have that permission by role; give it to anyone else through a
  role's **Debugger** scope (read only — see `14-limits-and-scopes.md`). An MCP account can never debug.

**A debugger session belongs to one space.** The person's `keen.json` names the space; their breakpoints stop
only runs of that space, and only the scripts / flow nodes they are set on. Other spaces and other scripts are
never held, and a second debugger window of the same kind is refused (*"… debugger is already in
use — one window per debugger at a time"*).

**How a person connects.** Nothing is issued from the console. The person puts their console e-mail and
password into their flow project's `.vscode/keen.json` (`user` + `password`, next to its `server`,
`space` and `token` — a local file, git-ignored, never committed: it holds the password and the
deployment token); the Keen VS Code extension (0.0.4 or newer — the console's home page has a
**Download Ext** button) signs in with them and connects. The toolkit's `agent-runner/debug.ts` does
the same for a manual attach.

**Built-in safety nets:**
- A run that stays paused at the **same point for 15 minutes** is resumed automatically, debugger attached
  or not. Any step or continue restarts the 15 minutes.
- A person's debug session ends on its own when the debugger is switched off, when the Debugger permission
  is removed from their role, or when their password changes.

So the honest split to tell a colleague:
- *"I want to step through my agent's logic and see what it's doing."* → do it in a **sandbox**, with
  the debugger.
- *"Something's wrong in production."* → don't count on attaching a debugger there. Reproduce it in
  a **sandbox** (with test traffic) and debug it there, then ship the fix.

## Watch out for

- **"The debugger won't connect"** — in order: is it switched **on** (Debugger page)? Does the person's
  role have the **Debugger** permission? Are `user` / `password` in their `keen.json` their *console*
  login? Is the extension 0.0.4 or newer? The extension's message names which one (*"The debugger is
  off — …"*, *"Your role has no Debugger permission — …"*, *"Sign-in refused — check "user" and
  "password" in .vscode/keen.json …"*).
- **Switch it off when the team is done** — off is the default for a reason; switching off also closes open
  sessions and resumes paused runs.

- **Don't point production traffic at a sandbox** — it's for building and testing, and won't hold up
  under real load. It exists so you can debug and iterate, not to run the product.
- **Debuggers are sandbox tooling** — if someone expects to breakpoint a live agent, set the
  expectation: reproduce in a sandbox instead.
- **Flow authoring lives elsewhere** — this folder deploys and debugs what's built; it does not teach
  building flows. Use the dedicated flow-builder guide (`../shira-flow-builder-guide/README.md`) for
  that.
