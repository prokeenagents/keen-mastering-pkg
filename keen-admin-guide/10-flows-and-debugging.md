# Flows & debugging

**In one line:** a flow is the step-by-step logic an agent runs. Authoring flows has its **own
dedicated guide** (separate, coming). Here we cover only what this guide is about: the fact that you
*can* debug them, and where.

## Flows — just enough

A **flow** is the logic an agent follows: ask the model something, run a script, branch on a
condition, call another flow, answer. Agents start from a flow + a node (you set that when you create
the agent). You build flows in your project and then **deploy** them into a space
(`04-deploy-a-project.md`).

**Authoring flows is not covered here.** There is a separate, dedicated guide for the flow builder —
if a colleague asks "how do I build a flow / what nodes are there / how do I wire them," point them
to that guide, not this folder.

## Debugging your agent

While you're building, you can **debug an agent's flows and scripts at the source level** — set a
breakpoint, run the agent, and step through your own code line by line, inspecting values as it goes,
from your IDE. It's the same experience as debugging any program, aimed at your flow/script logic.

### Where debugging is available — read this

- **Sandboxes have debuggers.** Every sandbox the platform renders — the development one and the
  production-shaped one alike — carries the flow and script debug bridges, exposed to your IDE
  through the CDP twins on ports **7101** (flows) and **7100** (scripts). Debugging is a build-time
  tool: don't assume a debugger is attached to an environment that serves real users.
- **A sandbox is a build-and-test environment, not the production version.** It is where you develop,
  try things, and debug — it is **not** meant to carry real production traffic, and it does **not**
  scale for it. Build and debug in a sandbox; serve real users from production.

So the honest split to tell a colleague:
- *"I want to step through my agent's logic and see what it's doing."* → do it in a **sandbox**, with
  the debugger.
- *"Something's wrong in production."* → don't count on attaching a debugger there. Reproduce it in
  a **sandbox** (with test traffic) and debug it there, then ship the fix.

## Watch out for

- **Don't point production traffic at a sandbox** — it's for building and testing, and won't hold up
  under real load. It exists so you can debug and iterate, not to run the product.
- **Debuggers are sandbox tooling** — if someone expects to breakpoint a live agent, set the
  expectation: reproduce in a sandbox instead.
- **Flow authoring lives elsewhere** — this folder deploys and debugs what's built; it does not teach
  building flows. Use the dedicated flow-builder guide for that.
