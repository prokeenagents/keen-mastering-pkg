# Deploy a project — taking an agent's code live

**In one line:** **deploying** publishes an agent's already-built project into a **space**, using that
space's **deployment token**; the project is compiled, its layout is checked, then it is security-scanned,
and only a clean bundle is promoted live — the running agent picks up the new version on its own, no
restart, no switch to flip.

## What "deploy" means here

An agent is a record **plus** its code — its **flows**, the scripts inside them, and the agent
definitions that run them. That code lives in a **project** you build on your machine. **Deploying** is
how that project reaches the running platform so the live agent actually uses it.

Two things this guide is **not** about:
- **Building the flows themselves.** Authoring flows has its own dedicated guide — if the question is
  "how do I build a flow / what nodes are there," that's `../shira-flow-builder-guide/README.md`, not
  here. See `10-flows-and-debugging.md`.
- **Chatting.** Deploying makes the code live, but talking to the agent still needs a **connected
  client** on top of it. Set that expectation: deploy is one step; a partner site or test app has to be
  wired too → `06-connect-a-partner-site.md`.

Deployment is always **scoped to one space**. A space's **ID doubles as its project ID**, so a deploy
lands in exactly one space and can only touch the flows that belong to it.

## Deploy a project into a space (the steps)

You need the target **space's deployment token** first — it's the credential that authorizes the
deploy. In the README's Golden path this is **step 14** — it comes *after* the partner site and API
access are wired and the key has been rebuilt + woken — and it's typically the AI agent that runs the
upload (with the Go deploy tool, see `../keen-mcp-guide/README.md`), using the token from step 1.

1. **Get the space's deployment token.** Go to **AI → Spaces → the space**, and click the **copy icon**
   next to the deployment token on its detail page. (If it may have leaked, click **Reset Token** to mint
   a fresh one first — see the warning below.) Hand the token to whoever runs the deploy.
2. **Deploy the built project into the space** using that token. The deploy authenticates into the
   space with the token, so a wrong or retired token is refused — only someone holding the **current**
   token can deploy, and the deploy can only land in that one space.
3. **It's built, checked, scanned, then promoted — automatically.** The bundle is compiled, its layout is
   checked (the flow map, at least one flow, the scripts folder), then the platform **security-scans** it
   for unsafe code. If everything passes, the project is promoted and the running system picks it up
   within moments. If any gate fails, the deploy is **rejected and never goes live** — the reply names
   the file/issue, and the previous version keeps serving, untouched.
4. **Confirm the agent picked it up.** The new version **replaces** the old one immediately: new runs
   use the new code, and a conversation that is mid-flow runs its **next step** on the new code (the
   platform re-reads the project at every step). Deploy in a quiet moment if the flow's shape changed.
   There's nothing to restart and no downtime.

## What the scan and supersession give you

- **Security scan** — the gate that makes it safe to run partner-authored script code on the platform.
  A project that doesn't pass is never promoted, so a rejected deploy leaves the live version exactly as
  it was.
- **Supersession** — there is **one live version per space** at a time, and re-deploying is the normal
  way to ship a change. You don't manage versions by hand.

## Watch out for

- **Keep the deployment token secret; Reset if it leaks.** **Reset Token** (on the space's detail page)
  mints a new token; every **new** deploy connection with the old value is refused from then on (a deploy
  session already opened with the old token can still finish within its short window). So reset, then
  distribute the new token right away.
- **Deploy targets a space, not "the agent."** The space ID is the project ID; a deploy lands in one
  space and touches only its flows. If a change didn't appear, confirm you deployed into the **right**
  space.
- **Authoring and deploying are different things.** This guide takes a *built* project live. Building
  the flows is a separate, dedicated guide (`../shira-flow-builder-guide/README.md`) — don't conflate
  the two.
- **A rejected (unsafe) deploy changes nothing.** The live agent keeps serving the last clean version
  until a passing deploy replaces it — a failed scan is not an outage.
- **Live code alone isn't a chat.** A deployed agent still needs a connected client before anyone can
  talk to it → `06-connect-a-partner-site.md`. And an **inactive** agent won't run regardless — check
  the Active switch (`03-spaces-and-agents.md`).
- **Deleting the space deletes its deployed project too**, along with its agents and settings — one
  action, no undo.
