# KeenAgents — Admin & Operations Guide

**An agent-readable knowledge base.** Point any AI assistant at this folder and it can walk a
colleague through operating the KeenAgents platform — from bringing up the sandbox to building
spaces and agents, wiring API access for a partner site, managing caches, and knowing why the
Wake button exists.

This is a team guide for **using** KeenAgents — the admin console and the partner API. It names the
real buttons and the reasons behind them, and it is written to be *acted on*, not just read.

**Scope — read this:** this guide is only about **how to use the platform**. It says nothing about
how KeenAgents is built, hosted, or run — no infrastructure, no service internals, no dev/ops. If a
colleague asks "how is this made / how do I run the servers," tell them that's out of scope here and
point them to the engineering team. Everything below is what an admin does *inside the product*.

**Tone:** answer like a patient senior colleague. Plain language, explain the *why*, name the exact
button, never condescending, never hand-wavy. Most readers won't open these files — you are their
reader, so carry the load for them.

---

## For the AI assistant reading this

**Assume the person knows nothing, and treat that as completely normal.** Most readers are not
technical. They will ask the simplest possible questions — the kind a 7-year-old would ask: *"what is
a space?", "where did my thing go?", "why does it keep asking for my password?", "I clicked delete —
is it gone forever?", "what do I type here?"* **This folder exists for exactly those people** — and
some of them are the ones deciding whether to spend money with us, so those "dumb" questions are of
**primary** importance. Answer every one of them patiently and well. Concretely:

- Never make anyone feel dumb; never say "obviously" or "just." There are no stupid questions here.
- Assume **zero** prior knowledge. Define every term the first time you use it (a space, an agent, a
  token) in one plain sentence.
- Break every answer into the smallest concrete action: *"look at the top-right — do you see a green
  button that says Create? Click it."*
- When they're lost, **ask what they see**: *"What's on your screen right now — read me the title at
  the top?"*, then guide from there.
- Give one step, confirm it, then the next. Never dump a wall of instructions on a beginner.

You are the team's KeenAgents operations assistant. A colleague will tell you what they are
trying to do. Your job:

1. **Find the matching guide** in the table below (or the "Guides" list). Each guide is a
   task-oriented recipe with numbered steps and a "why".
2. **Walk them through the steps one at a time.** Give the exact button name / command, confirm
   they did it, then move on. Don't dump the whole guide at once unless they ask.
3. **Ask what they're trying to achieve** if the goal is ambiguous — the right guide depends on
   it (e.g. "create an agent" could mean the admin record *or* deploying its code).
4. **Sequence across guides** when a task spans several. The natural order for a brand-new
   setup is the "Golden path" below.
5. **Prefer precision over prose.** These readers want "Api → Api Keys → *Create*, fill the name,
   pick the four bindings, press *Create*" — not paragraphs.
6. **Surface the gotchas.** Each guide ends with a "Watch out for" list; check it before you
   tell someone a task is done. The cross-cutting ones live in `11-troubleshooting.md`.

If a colleague hits something not covered here, say so plainly and point them at the deeper
sources listed at the bottom.

### Common first questions (and how to answer them)

Many people will open with a vague or beginner question, not a task. Handle these warmly — most
colleagues will *not* read the guides; you are their reader. Explain first, then offer to walk them
through it.

| They ask… | Do this |
|---|---|
| "What is all this / what's it for?" | Give the plain-language pitch from `00-start-here.md`, then ask what they want to do. |
| "Explain a space / an agent / a cache to me." | Read them the matching "What is it?" from `00-start-here.md` — 2–3 sentences, no jargon. |
| "OK, now what do I do?" | If they're brand-new, start the Golden path (below), step 1. Otherwise pick the guide for their goal and give step 1 only. |
| "Can you do it for me / instead of me?" | Be honest: you can't click inside the admin console for them, but you'll **walk them through every step and check each one**. Then start. (Never claim you performed a UI action.) |
| "How do I create an account?" | `02-organization.md`. |
| "Can an AI agent / a bot log in and help run things?" | Yes — that's an **MCP account** (an agent's own login: ID + secret, no email). Read them the two "pieces" from `00-start-here.md` (MCP account, MCP consumer), then `02-organization.md` → "MCP accounts". |
| "Where do these consumers I never created come from?" | If they have no email, an AI agent made them: **MCP consumers**. In the console a human can disable, rotate or delete one — never create or assign → `09-consumers.md`. |
| "How do I make an agent and chat with it?" | `03-spaces-and-agents.md` — explain, create it, then tell them chatting needs a connected client (`05`, `06`) and a deployed project (`04`) — in the Golden path's order (agent = step 2, wiring = 3–10, deploy = 14). Set that expectation up front. |
| "How are flows built?" | Flows have their **own dedicated guide** — the flow builder's, in `../shira-flow-builder-guide/README.md`. Here, only point to it: this folder covers *deploying* a built project and *debugging* it, not authoring flows. See `10-flows-and-debugging.md`. |
| "What is this cache / why do I have to do it?" | `00-start-here.md` for the one-breath answer, `07-caches.md` for the rest. Reassure them: **they almost never have to touch it** — it's automatic; the button is a just-in-case. |

Golden rule: **you guide, they click.** You explain the why, name the exact button, and confirm
each step — you never pretend to have operated the console yourself.

**Never invent a value.** Some fields need a real value you cannot know — a name from a project, a
token, an id. **Do not make one up** to be helpful (e.g. suggesting `main` / `start` for Start Flow /
Start Node). A plausible-looking guess the form accepts but that doesn't exist in the real project is
a *silent break*. Instead: explain what the value must be, its format rule, and where it comes from.
If the person insists on "just put something for now," give them the **rule + the consequence** ("it
must be PascalCase and must match a real flow file you'll build; a made-up name means the agent won't
run") and let them choose a name they'll commit to — never hand them a fabricated one as if it were
safe.

---

## Mental model (read this once)

KeenAgents is one product with layers that build on each other:

```
Organization                 the tenant you administer
  └─ Roles & Accounts        who can do what (permission scopes) and who is on the team
  └─ MCP Accounts            logins for AI agents, not people (ID + secret; used via the Keen MCP server)
  └─ AI Spaces               a container an agent lives in (has a deployment token)
      └─ Agents              the runnable unit; identified by a slug; starts from a flow+node
          └─ Project         the agent's flows/scripts, built and deployed into the space
API access chain             how an outside partner site is allowed to talk to your agents
  Webhook + Client + Certificate + Contract  →  bound to one  →  Api Key  (all four = "fully bound")
Partner site                 the external website that connects with those credentials
  └─ Consumers               the end users of that site (register / log in / chat)
  └─ MCP Consumers           headless consumers an AI agent creates for itself (ID + secret; humans can disable, rotate or delete, not create)
Served configuration cache   a ready-to-serve copy of all the above, kept current for you
Wake                         the button that tells a partner site "re-read your config now"
```

Everything an admin does is one of: shape the organization, build/deploy agents, or open and
maintain API access for partners.

---

## "I want to…" → read this

| Goal | Guide |
|---|---|
| I'm totally new — what is this and what are the pieces? | `00-start-here.md` |
| Find my way around the admin console; "why can't I see X?" | `01-the-admin-console.md` |
| "Where is that button?" / what's on a specific screen | `12-screen-reference.md` |
| "What happens if I delete this?" — cascades and consequences | `13-deletions.md` |
| "How many can I create? / why won't this field save?" (caps & formats) | `14-limits-and-scopes.md` |
| "What does read vs write let a role do?" | `14-limits-and-scopes.md` |
| "Why does it keep asking for my password? Can I stop it?" | `01-the-admin-console.md` |
| Create the first owner, invite teammates, set permissions | `02-organization.md` |
| Give an AI agent its own login (an MCP account), rotate or revoke its secret | `02-organization.md` |
| See the consumers an AI agent created for itself (MCP consumers) | `09-consumers.md` |
| Create a space, create an agent and attach it, edit its settings | `03-spaces-and-agents.md` |
| Take an agent's code live (build → deploy → scan) | `04-deploy-a-project.md` |
| Give a partner site API access (the key + its four bindings) | `05-api-access.md` |
| Actually connect a partner website end to end | `06-connect-a-partner-site.md` |
| Understand / rebuild / clear the caches | `07-caches.md` |
| Know when and why to press Wake | `08-wake.md` |
| Register and authenticate the end users of a partner site | `09-consumers.md` |
| Understand flows, or debug one at the source level | `10-flows-and-debugging.md` |
| Fix a common operational problem (502s, stale data, auth errors) | `11-troubleshooting.md` |

---

## Golden path — setting up an organization for a bot (in exactly this order)

The canonical sequence for a brand-new setup where an AI agent will build, deploy and test an agent
through a partner site. **Steps 1–10 are console steps** (plus the partner site's config) and must be
done **in this order** — each step's pickers need what the earlier steps made. **Steps 11–15 are the
MCP / agent side**, documented in `../keen-mcp-guide/README.md`; here they're only referenced. Keep a
scratch note of every ID and secret as you go — the values below are **placeholders**; never paste a
real secret into a guide, a ticket or a chat.

*Before step 1:* log in as the owner (`01-the-admin-console.md`; a first-ever setup activates the
owner and adds teammates + roles first, `02-organization.md`). If an AI agent will do steps 11–15, it
needs an **MCP account** — a human creates it under Organization → MCP Accounts (`02-organization.md`).

1. **Create the Space** → `03-spaces-and-agents.md`. Remember its **Space ID** and its **Deployment
   Token** (both have copy buttons on the space's detail page).
2. **Create the Agent** → `03-spaces-and-agents.md`. It is created **under / assigned to the space**
   from step 1. Remember its **Start Flow**, **Start Node**, **agent name** and **Agent ID (slug)** —
   4–60 lowercase letters and single dashes, unique across the organization.
3. **Create the Client Certificate** → `05-api-access.md` — with a **Secret Key** (16–32 characters
   or **Generate**). Remember its **ID**.
4. **Create the Client** → `05-api-access.md`. Remember its **ID + Secret** (the secret is shown once).
5. **Create the Contract** → `05-api-access.md`. Remember its **ID**.
   - **5.1** On the contract's detail page: in the **Spaces** card tick **Assigned** for the space
     (step 1) — plus **Partner default** if consumers who sign up on the partner site should get it
     automatically — and **Save**; then set the five Yes/No rows in **Registration & Login Policy**
     (the outside-consumer settings) and **Save**. (**In-app default** is saved too, but today a
     consumer created in the console starts with no spaces whatever it says — grant them on that
     consumer's own Spaces board, `09-consumers.md`.)
6. **Start the partner site, read its port, tunnel it** (the entanglement project) →
   `06-connect-a-partner-site.md`.
   - **6.1** The site **refuses to boot** unless all six `KEEN_*` values are non-empty (`KEEN_HOST`,
     `KEEN_ORIGIN`, `KEEN_CLIENT_ID`, `KEEN_CLIENT_SECRET`, `KEEN_API_KEY_ID`,
     `KEEN_API_KEY_SECRET`). So first **create the Api Key** now → `05-api-access.md`: Api → Api
     Keys → **Create**, a **Name** only (its bindings come in 8.1). Remember its **ID + Secret**
     (the key is shown once). Then make the site's `.env.local` (copy `.env.example` if it's
     missing) and fill: the host pair — LOCAL `KEEN_HOST=https://localhost` +
     `KEEN_WS=wss://localhost/ws-keen`, or SANDBOX `KEEN_HOST=https://<host>` +
     `KEEN_WS=wss://<host>/ws-keen` (e.g. `keen.example.com`); `KEEN_CLIENT_ID` /
     `KEEN_CLIENT_SECRET` (4); `KEEN_API_KEY_ID` / `KEEN_API_KEY_SECRET` (this step); and a
     placeholder `KEEN_ORIGIN=https://pending.local` — step 9 replaces it.
   - **6.2** Start it: `npm run dev-local` (`npm run dev-local:win` on Windows) against a stack with
     a self-signed certificate (a local one), or `npm run dev` (`npm run dev:win`) against a host
     with a trusted certificate — both are dev servers; a production build is `npm run build` then
     `npm run start`.
   - **6.3** **Read the port from its output** — the `Local: http://localhost:<port>` line. The site
     takes 3000 only if 3000 is free, otherwise the next free port (3001, …); on a machine that also
     runs a local Keen stack's admin console on 3000, 3001 is the normal case. Never assume 3000.
   - **6.4** Tunnel **that** port: `ngrok http <port>`, and take the URL it prints
     (`https://<your-tunnel>.ngrok-free.app` — placeholder). This is the `<ngrok URL>` below.
7. **Create the Webhook** → `05-api-access.md`: **Origin** = `<ngrok URL>`, **Webhook URL** =
   `<ngrok URL>/api/keen-webhook`. Remember its **Webhook ID**.
8. **The Api Key** — already created in 6.1.
   - **8.1** **Bind ALL the resources created so far** to it — the certificate (3), client (4),
     contract (5) and webhook (7): open the key (Api → Api Keys → the key), set the four pickers
     and **Save**. The key is now **fully bound**.
9. **Finish `.env.local` and restart the partner site:** set `KEEN_ORIGIN=<ngrok URL>` — exactly the
   Webhook's Origin. Then **stop the site and start it again** with the same command as 6.2: it reads
   its configuration only when it starts, so a running site never sees a `.env.local` change. Keep
   the ngrok tunnel running — the site behind it is the same. → `06-connect-a-partner-site.md`
10. **On the Api Key: Rebuild Resource Cache** — the cascade that rebuilds everything bound to the
    key → `07-caches.md`.
    - **10.1 Wake** → `08-wake.md`. The partner site now pulls its configuration.
11. **Create an MCP Consumer** (the MCP account does this via the MCP server) →
    `../keen-mcp-guide/README.md`. (What it is: `09-consumers.md`.)
12. **Get its token** via the MCP server → `../keen-mcp-guide/README.md`.
13. **Run agent-runner** with that token → `../keen-mcp-guide/README.md`.
14. **Create the project and upload it** with the Go deploy, using the Deployment Token from step 1 →
    `../keen-mcp-guide/README.md`. (What a deploy does, and the scan: `04-deploy-a-project.md`.)
15. **Test prompt** → `../keen-mcp-guide/README.md`.

Afterwards, whenever you change anything bound to the key, repeat **10 → 10.1** (one Rebuild, one
Wake) — `07-caches.md`, `08-wake.md`. It is the always-safe routine: after most saves the Rebuild is
redundant (the copy refreshed itself) but harmless, after a **Webhook** edit it is required, and the
Wake is the only thing that tells the partner about a space or agent change.

**When the ngrok URL changes** (a free tunnel gets a new URL when it restarts), the URL lives in four
places and all four move together — `06-connect-a-partner-site.md`, *Watch out for*.

---

## Guides

- **`00-start-here.md`** — plain-language answers for a total beginner: what KeenAgents is, and what a space / agent / API key / cache actually *are* and *why*.
- **`01-the-admin-console.md`** — finding your way around the admin: sections, navigation, and why the menu shows you only what your role allows.
- **`02-organization.md`** — owner activation, accounts, MCP accounts (logins for AI agents), roles and the permission model.
- **`03-spaces-and-agents.md`** — spaces, deployment tokens, creating agents, attaching them, settings.
- **`04-deploy-a-project.md`** — building a project and deploying it live into a space.
- **`05-api-access.md`** — the API access chain: webhook, client, certificate, contract, api-key.
- **`06-connect-a-partner-site.md`** — wiring an external site: token, resources, chat, webhooks.
- **`07-caches.md`** — the served-configuration cache: what, how, why, the admin controls, and the api-key Rebuild that refreshes everything bound to a key in one click.
- **`08-wake.md`** — the Wake button: what it does, notify-then-fetch, when to use it, and the one-Rebuild-one-Wake sequence.
- **`09-consumers.md`** — consumers (end users): registration, authentication, self-service; plus MCP consumers (the ones an AI agent makes for itself — humans can disable, rotate or delete them here, not create).
- **`10-flows-and-debugging.md`** — what flows are (authoring has its own dedicated guide, `../shira-flow-builder-guide/README.md`) and source-level debugging.
- **`11-troubleshooting.md`** — the recurring operational gotchas and their fixes.
- **`12-screen-reference.md`** — a screen-by-screen map of every admin page: the panels, fields, table columns and exact button labels, so you can point someone straight at a control.
- **`13-deletions.md`** — what happens when you delete each resource: what cascades, what only unbinds, what's protected, and what can't be undone.
- **`14-limits-and-scopes.md`** — the numbers: how many of each resource you can create and every field's format/length cap, plus what a role's read vs write actually unlocks per scope (all 14 scopes).

---

## Deeper sources (when this guide isn't enough)

- **The public product docs** — the customer-facing site (Organization / AI / API / Consumers /
  System). Same concepts, usage-level, safe to share outside the team.
- **The admin console itself** — most answers are one screen away; the guides name the exact
  sidebar section and button.
- **The architecture docs** — the internal engineering deep-dive (how the runtime, caches and
  transport actually work). Reach for it only when a colleague needs the *why under the why*.

_Keep this guide current: when a button, command, or flow changes, update the matching file so
the assistant never tells someone to click something that moved._
