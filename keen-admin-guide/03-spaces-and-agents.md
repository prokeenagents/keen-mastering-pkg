# Spaces & agents

**In one line:** a **space** is the room an agent lives in; an **agent** is the assistant itself.
You create a space, create agents inside it, and (once their code is deployed and a client is
connected) people chat with them.

## What is a space?

A space is a **container** for agents. It does two jobs:
- it **groups** agents that belong together, and
- it holds a **deployment token** — the password used to publish an agent's code into it.

You also grant partners access to **whole spaces** (through a consumer contract), so a space is the
unit of "who can reach these agents." Deleting a space **cascades**: the agents inside it go with it.

### Create a space

1. Go to **AI → Spaces → Create**.
2. Give it a **title** and a **description** (both required and **both unique** — title up to 150
   characters, description up to 500; two spaces can't share a description either, and a duplicate is
   refused with a general "not acceptable" message).
3. Save. The space now has its own **Space ID** (there's a copy button) and a **deployment token**.
4. On the detail page you'll find the **copy icon** next to the deployment token and a **Reset Token**
   button (write permission only), the **Space ID** copy icon, and — once the space has at least one
   agent — an **Assigned Agents** table.

> The **deployment token** is what a developer uses to publish an agent's project into this space
> (see `04-deploy-a-project.md`). **Reset Token** mints a new token; from that moment every **new** deploy
> connection with the old value is refused. (A deploy session that was already opened with the old
> token can still finish for a few minutes — up to its short session window.) Do it if the token
> leaks, then hand the new one to whoever deploys.

## What is an agent?

An agent is the runnable assistant. Its key parts:
- **Display name** — what humans call it.
- **Agent ID (slug)** — its **stable id**: **kebab-case** — lowercase letters and single dashes
  (e.g. `support-bot`), no capitals, no digits. It is **unique across the whole organization** — two
  spaces can't both have a `support-bot`. The form accepts 3–100 characters, but pick one **4–60**
  characters long: the flow builder's Agent ID field allows only that, so such a slug passes every
  check. Everything refers to the agent by this slug — deployments, chats, settings. Renaming it is
  possible but disruptive (things that referenced the old slug must be updated), so choose it well.
- **Start Flow + Start Node** — where the agent begins running. These are two required fields with
  their own rules — see the section below; they are the #1 thing people get wrong.
- **Active** — a switch; only active agents run.
- **Settings** — two separate channels, each on its own page:
  - **Json Settings** — custom fields your agent's scripts read while running.
  - **Front Settings** — configuration a **partner site** reads (partner-facing).

### Create an agent and attach it to a space

"Attaching" an agent *is* creating it inside a space — an agent always belongs to exactly one space.

1. Go to **AI → Agents → Create**. (The space page's **Assigned Agents** table only lists and links to
   existing agents — it has no Create button.)
2. Pick the **Space** it lives in.
3. Set the **Display Name** and the **Agent ID (slug)**. The form helps: typing the display name
   suggests a slug; edit the slug directly to stop that.
4. Fill **Start Flow** and **Start Node** — see the section right below; don't guess these.
5. Save. The agent is created **Active** by default; the **Active** switch lives on the agent's detail
   page if you ever need to pause it. Optionally open **Json Settings** and **Front Settings** to define
   its custom fields — each page has its own **Update Settings** button (up to 1,000,000 characters).

### Start Flow & Start Node — what to actually type

This is where most people (and assistants) go wrong. Read it before filling those two fields.

- **Start Flow** is the name of a **flow file** in the agent's project. A flow *is* a file — the
  scenario the agent runs (e.g. take the question → send it to the model → answer). Start Flow says
  *which file* to run.
- **Start Node** is the **starting node inside that flow** — the first step, a dedicated start node
  the flow begins at.

**The naming rule (the form enforces it):** both Start Flow and Start Node must be **PascalCase** —
**start with a capital letter**, then only letters and digits, **no dashes, no spaces**, at least
3 characters. Examples: flow `MainFlow`, node `Start`. Anything else is rejected.
⚠️ This is the **opposite** of the Agent ID slug (which is lowercase-with-dashes) — do not mix the
two rules up.

**They must exactly match the real names in the project you deploy into this space.** They are not
free text: when the agent runs it looks up *this exact flow file* and *this exact node*. If the
deployed project has no flow/node with those names, the agent does nothing.

**"Can I just set something for now?"** — Yes, but *not a random word*. Enter the names you will
actually use when you build the project, following the PascalCase rule (a common choice is
`MainFlow` / `Start`), and make sure your project ends up with a flow file and start node named
**exactly** that. If you don't know the names yet, get them from whoever builds the flow (flows are
authored with the flow builder — `../shira-flow-builder-guide/README.md`) rather than inventing values
that won't exist. **Never fill these with a guess an assistant made up** — a made-up name that
isn't in the project is a silent break: the form accepts it, but the agent never runs.

### "How do I chat with my agent?"

Making the agent record is only step one. To actually talk to it, **three** things must be true:

1. the **agent exists** (you just made it),
2. its **code is deployed** into the space → `04-deploy-a-project.md`, and
3. a **client is connected** to it — a partner website or a test app → `06-connect-a-partner-site.md`.

There is **no chat box inside the admin console** — chatting always happens through a connected
client. So the honest answer to a colleague is: "make it → wire API access and connect a site →
deploy it → then chat" — in the README's **Golden path** the agent is step 2, the wiring is steps
3–10, and the deploy is step 14.

## Watch out for

- **Two different naming rules — don't swap them.** Agent ID (slug) is **kebab-case** (lowercase +
  single dashes, no capitals/digits, 3–100 chars, unique org-wide — keep it 4–60 so the flow builder
  accepts it too). Start Flow / Start Node are **PascalCase** (capital first, letters + digits, no
  dashes, 3–60 chars). The form rejects the wrong format.
- **Start Flow / Start Node must match the deployed project** — they name a real flow file and its
  start node. A guessed value the form accepts but the project doesn't contain = the agent silently
  never runs. Don't invent them.
- **Renaming the slug is disruptive** — the form warns you. Anything referencing the old slug (a
  deployed project's entry, a partner's config) must be updated too.
- **Inactive agents don't run** — if an agent "doesn't respond," check the **Active** switch first.
- **Deleting a space deletes its agents** — the cascade is intentional and not reversible; move or
  re-create agents elsewhere first if you need them.
- **Settings blobs are separate** — editing Json/Front Settings never touches the agent record, and
  vice versa; each is saved on its own page with **Update Settings**.
- **Caps:** 20 spaces per organization, 10 agents per space — Create refuses with "Space limit
  reached…" / "Agent limit reached…" (full list in `14-limits-and-scopes.md`).
