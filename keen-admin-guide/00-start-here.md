# Start here — what all of this is, in plain words

New to KeenAgents? Read this once. No jargon, no steps yet — just what the pieces *are* and *why*
they exist. When you're ready to actually do something, each part points you to the guide with the
steps.

> If an assistant is reading this to you: answer the person's question with the matching 2–3
> sentences below, then ask what they'd like to do next.

---

## What is KeenAgents, and what's it all for?

KeenAgents is a platform for building **AI agents** — little assistants that can chat and do work —
and putting them on **other people's websites**. You (the admin) create the agents and decide who is
allowed to use them. A partner (another company or team with a website) plugs their site into your
agents so their visitors can chat with them. That's the whole point: **you make agents here, other
sites use them there, safely.**

Your job as an admin is one of three things at any moment: shaping your **organization** (your team
and what they can do), building and shipping **agents**, or opening and maintaining **API access** so
partner sites can connect.

---

## The pieces, one by one

**Organization** — your whole tenant: your team, your agents, your partners. Everything you manage
lives inside it. *(Guide: `02-organization.md`)*

**Account** — a login for a person on your team. The very first one is the **owner** (that's how the
system is born); everyone else is **invited**, never self-signed-up. Each account has a **role** that
says what it's allowed to touch. *(Guide: `02-organization.md`)*

**Role** — a named bundle of permissions. Instead of ticking boxes per person, you make roles ("can
edit agents", "can manage API access") and hand a role to each account. *(Guide: `02-organization.md`)*

**The Keen MCP server** — the door an **AI agent** (an assistant like Claude or Codex, working on
your behalf) uses to get into your organization: it signs in there with a credential you made for it,
and from then on it works inside KeenAgents the way a teammate would.

**MCP account** — a login **for an AI agent, not a person**. Think of it as an "agent helper" on your
team: it has a name and a role like any account, but **no email and no password** — instead it gets an
**ID + a secret** (the secret is shown **once**, right after you create it). The agent uses that pair to
sign in through the Keen MCP server and then does only what its role allows. It can never manage
people, roles, or other MCP accounts. *(Guide: `02-organization.md`)*

**Space** — think of it as a **folder or room that an agent lives in**. It groups agents and holds a
**deployment token** (a password used to publish an agent's code into it). You put agents in spaces;
you give partners access to whole spaces. *(Guide: `03-spaces-and-agents.md`)*

**Agent** — the actual assistant. It has a name, a short **slug** (its stable id, how everything
refers to it), and a starting point (which flow it runs first). You can also give it **settings** —
custom fields it reads while running, and separate settings a partner site can read. An agent is a
record here **plus** its code (its flows), which you deploy. *(Guide: `03-spaces-and-agents.md`)*

**"How do I chat with my agent?"** — three things have to be true: the agent exists (you made it),
its code is **deployed** into the space, and a **client** (a website or a test app) is connected to
it. Chatting always happens through a connected site, not inside the admin console. So the path is:
make the agent → open API access and connect a client (`05`, `06`) → deploy its code (`04`) → chat —
the README's **Golden path** has the exact order. *(Set this expectation early — people often expect
a chat box in the admin, and there isn't one.)*

**Flow** — the step-by-step logic an agent follows (ask the model something, run a script, branch,
answer). **Building flows has its own dedicated guide** (`../shira-flow-builder-guide/README.md`).
Here we only cover *deploying* a built project and *debugging* it. *(Guide:
`10-flows-and-debugging.md`)*

**API access chain** — how an outside site is *allowed* to talk to your agents. It's four small
records — a **Client** (the partner's identity), a **Certificate** (signing material), a **Consumer
Contract** (their policy + which spaces they get), and a **Webhook** (their website address + a
notify URL) — all clipped onto one **Api Key**. When all four are clipped on, the key is **"fully
bound"** and works. Think of the key as a keyring and the four as the keys on it. *(Guide:
`05-api-access.md`)*

**Partner site** — the external website that connects using those credentials. Its end users are
called **consumers**. *(Guides: `06-connect-a-partner-site.md`, `09-consumers.md`)*

**Consumer** — an end user of a partner's site (not your teammate — their visitor). They register,
log in, and chat with your agents through the partner site. *(Guide: `09-consumers.md`)*

**MCP consumer** — a consumer that an **AI agent** made for itself, so it can chat with your agents the
way a site visitor would — but headless: **no email, no password, never a one-time passcode**, just an
**ID + a secret**. It belongs to a partner's contract and gets some of that contract's spaces. An MCP
account creates these and wires them up through the Keen MCP server; in the admin console you can
**look** at them and — with write — disable, rotate or delete one, never create.
*(Guide: `09-consumers.md`)*

---

## "What is this cache, and why do I have to do it?"

**You almost never have to do anything about it.** Here's the plain version:

KeenAgents keeps a **ready-to-serve copy** of your configuration (your spaces, agents, API keys, and
so on) so that admin pages and partner sites load **instantly** instead of waiting for a lookup every
time. The important part: **it keeps this copy up to date for you automatically.** The moment you
save a change, the copy refreshes — no button, no waiting. (One exception: an edit to a **Webhook**
reaches the copy only when you press Rebuild on its key — `07-caches.md`.)

So why is there a **Rebuild** button at all? As a just-in-case. If you ever suspect something didn't
refresh (say after a big batch of changes, or a partner reports stale data), you can press it to
force a fresh copy. In day-to-day work you can ignore it. *(Guide: `07-caches.md`)*

## "And what's Wake?"

**Wake** is a button on an API key that hands a **partner site** its starting kit — the certificate
material it needs to trust our tokens — and tells it: "your configuration changed — go re-read it."
The site then pulls the fresh values itself. It's how a partner stays current without constantly
asking. Some changes send a lighter automatic nudge on their own — edits to the partner's contract,
certificate, client or key. Changes to a **space**, an **agent** or an agent's front settings send
**none**: for those you press **Wake** yourself, just as you do to push the *first* configuration to a
newly-wired partner (and after a Rebuild). It does **not** change any of your data — it only
delivers and nudges. *(Guide: `08-wake.md`)*

---

## Ready to do something?

- Brand-new setup, from scratch → follow the **Golden path** in `README.md`.
- A specific task → find it in the **"I want to…"** table in `README.md`.
- Still unsure what you need → tell the assistant your actual goal in one sentence ("I want a partner
  site to chat with my support agent") and it'll pick the right guides and sequence them.
