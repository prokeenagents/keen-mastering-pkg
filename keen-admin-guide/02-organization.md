# The organization — accounts, roles & permissions

**In one line:** your **organization** is the whole tenant you administer; **accounts** are the
people on your team, **MCP accounts** are logins for AI agents that help run it, **roles** are the
bundles of permissions you hand them, and a role is what makes the right menus and buttons appear.

## What is the organization?

The organization is everything you manage: your team, your spaces and agents, and your partner API
access. It is born from a single **owner** account and grows by **invitation** — nobody self-signs-up
into your team. Three Organization sections in the sidebar cover this guide: **Accounts** (the
people), **MCP Accounts** (the AI agents you let in), and **Roles** (what they're all allowed to
touch). All three belong to the **owner and admins**: only they see and manage them (everyone can
still open their own profile from the avatar menu).

## Owner bootstrap — the very first account

Your organization has **exactly one owner**, and it is created **once**, through a one-time
**activation** screen that is only reachable while the organization has **no confirmed owner**. The
first owner email submitted there creates a pending (unconfirmed) owner; the page stays open until
that owner confirms, and the moment they do it closes for good — visitors are sent to sign-in — and
from then on every new teammate is **invited**, never activated. There is no second owner and no self-signup, by design: the
first account is always the owner, and the top of the hierarchy can never be accidentally demoted.

### Create the first owner (activate)

1. Open the **Activate** screen yourself: type `/activate` after the admin's address in the browser
   (nothing links to it, and the login page won't redirect you there). Its title is **Activate
   Organization**.
2. **Double-check the email** before you go on — see the note below. Enter the owner's **email** and
   press **Send Activation Mail**. The page parks in a "check your inbox" state (*"Activation mail
   sent — check the inbox"*) — the rest happens in the email.
3. Open the emailed **confirmation link** (valid **24 hours**, like every confirmation link). The
   **Confirm Account** page asks for the **email the mail was sent to** (type it — the link itself
   only carries a code), the owner's **First Name**, **Last Name**, a **Password** and **Confirm
   Password**. Press **Confirm Account**.
4. The owner is now **Active** and can sign in (the login page says *"Account confirmed. Sign in
   with your new password."*). Everyone after this joins by invitation.

> **A typo in the owner email: submit again.** Until the owner confirms, the activation page stays
> open, and a new submission **replaces** the pending owner: the new address gets a fresh link and
> every link mailed before stops working. Once an owner has confirmed, the page shows *"Activation is
> closed"* and sends you to sign-in. Because anyone who reaches `/activate` before the confirmation
> could replace the pending owner the same way, confirm the link as soon as it arrives.

## Roles — what a role is

A **role** is a named bundle of **permission scopes**. Every account carries exactly **one** role, and
that link can never dangle (an account can't point at a role that doesn't exist). A role has:

- a human-facing **Title** (unique, up to 60 characters),
- a **Slug** derived automatically from the title (you never type it — it's the stable id integrations
  store), and
- per scope, what the role can **read** (see) and what it can **write** (change).

**Write implies read.** A role that can change something it can't see would be inconsistent, so
granting **Write** on a scope always grants read too. On the permissions board each scope shows four
positions — **Read**, **Write**, **Import**, **Export** — and Write can only turn on while Read is on;
turning Read off clears Write with it. Import and Export are switched off and not available yet.

A role can grant twelve scopes, each mapping to an area of the console:

| Scope | Unlocks |
|---|---|
| `consumer` | Consumers → `09-consumers.md` |
| `mcp_consumers` | MCP Consumers — the consumers an AI agent makes for itself → `09-consumers.md` |
| `spaces`, `agents` | Spaces & agents → `03-spaces-and-agents.md` |
| `api_keys`, `clients`, `certificates`, `contracts`, `webhooks` | API access → `05-api-access.md` |
| `cache` | The cache controls → `07-caches.md` |
| `logs` | Audit & activity logs |
| `debug` ("Debugger") | Attaching the flow and script debuggers, and the Debugger page — **read only** → `10-flows-and-debugging.md` |

**Accounts, MCP Accounts and Roles are not on the board:** they belong to the owner and admins by
role, and no other role can be granted them. The compact form of a role's grants — the 15-scope,
88-character permission string — is explained in `14-limits-and-scopes.md`.

### Create a role

1. Go to **Organization → Roles → Create**.
2. Enter a **Title** (the slug is derived for you) and press **Create** — you land on the new role's
   detail page.
3. On the detail page, use the **permissions board**: flip **Read** on for each area the role
   should see, and **Write** on for each area it should change. **Save**.

> Titles can't be — or even contain — a protected name (`admin`, `owner`, `developer`, `default`), so
> "Support" is fine but "Default Support" is refused. Save is **dirty-gated** — it only lights up once
> you've actually changed something.

## Accounts — the people on your team

An **account** is a login for a teammate. It carries a globally unique email, the role you assign, and
a status. Names are **set by the user themselves** when they confirm — you don't type them, and you
can't edit them from the admin side (the person can change their own names later from the avatar
menu → **Account**). Passwords are never shown or recoverable.

### Create an account and assign a role

1. Go to **Organization → Accounts → Create**.
2. Enter the person's **email** and pick a **role** from the select (the **owner** role is never
   offered — you can't mint a second owner — and **admin** is offered to the owner only). Press
   **Create**.
3. KeenAgents emails them a **confirmation link**; the account shows **New** until they finish.

### The account lifecycle: invite → confirm → active

1. **Invite.** You create the account with an email + role. It's stored unconfirmed — the emailed
   confirmation link is its **only** credential until the user registers. Status: **New**.
2. **Confirm.** The user opens the link (valid **24 hours**). The **Confirm Account** page asks them
   to type the **email the mail was sent to** (the link only carries a code), their **First Name**,
   **Last Name**, a **Password** and **Confirm Password**. Tell them to use the exact address you
   invited — a different one fails with *"Confirmation failed. Check the email and use the latest
   mail link."*
3. **Active.** The account can now sign in. Its name fields are filled; they stay read-only to admins.

### Reset password & delete

- **Reset Password** appears only on **confirmed, non-owner** accounts. It invalidates the current
  password **immediately** (the moment the reset email is sent, not when the link is used). It is
  deliberately **hidden on New accounts** — resetting one would kill the pending confirmation link and
  strand the person.
  - **How the person completes it:** they open the **emailed reset link**, set a **new** password, and
    log in with the new one. There is **no "forgot password"** on the login screen — a locked-out
    teammate asks an admin (or the owner) to press this button for them. Between the reset and setting
    the new password, **neither** password works — so tell them to open the email straight away.
  - **Still signed in?** Anyone — the owner included — can reset their **own** password without an
    admin: avatar menu → **Account** → **Send Reset Mail**. It works the same way (the current
    password stops working the moment the mail is sent; the emailed link sets the new one). The
    owner's account has no **Reset Password** button on the admin side; a locked-out owner goes
    through the engineering team.
- **Reset MFA** (owner / admin, on the same accounts as **Reset Password**) clears a person's two-step
  sign-in — for a lost phone or mailbox — and ends their sessions. See *Two-step sign-in* in
  `01-the-admin-console.md`.
- **Delete** is **two-step** (Delete → Confirm). Deleting an account also ends any live session it had,
  in the same action.

## MCP accounts — agent helpers

An **MCP account** is a login **for an AI agent, not for a person**. Think of it as an "agent helper"
on your team: an assistant like Claude or Codex that you let into your organization so it can do real
work — check on spaces, look at consumers, whatever its role permits. It gets in through the **Keen
MCP server** (the door AI agents use to work inside KeenAgents; MCP is the standard way an assistant
plugs into tools). Once signed in, it acts **as that account**, with exactly that role's permissions,
and everything it does lands in the action log under its name — just like a teammate.

What makes it different from a human account:

- **No email, no password, no invitation or confirmation mail.** Its credential is an **ID** (shown on
  its page, with a copy button) plus a **secret** that is shown **once**, right after you create it.
  You hand the pair to whoever sets up the agent.
- **Name is unique and permanent.** Two MCP accounts can't share a name (a duplicate is refused), and
  the name can't be changed after creation — on the detail page it is read-only, like the ID.
- **It is never owner or admin, and it never manages people or roles.** An MCP account can hold any
  role except **owner** and **admin**, so it can never see or change human accounts, roles, or other
  MCP accounts. Only a **human** owner or admin manages MCP accounts.
- **It cannot make people-consumers either** — it can only *view* normal consumers; the consumers it
  is allowed to create are its own **MCP consumers** (`09-consumers.md`).

### Create an MCP account

1. Go to **Organization → MCP Accounts → Create** (the section is visible to the owner and admins
   only).
2. Enter a **Name** (unique across MCP accounts — choose it well, it can't be changed later), pick a
   **Role** (any role except **owner** and **admin**), and leave **Enabled** on. Create.
3. A **one-time secret panel** appears: the account's **ID** and its **secret**, each with a copy
   button. **Copy both now** — the secret is never shown again. Then click
   **I have copied it — open the account**.
4. Give the ID + secret to the person (or pipeline) configuring the agent. The agent signs in through
   the Keen MCP server with them; a **Last login** badge on the account's page shows when it last did.

### The detail page: Save, Rotate Secret, Delete

- **Role** — change it and **Save**. A real change **ends the agent's current session**: its next
  token renewal is refused, so within about **10 minutes** (the life of the token it already holds)
  it has to sign in again through the Keen MCP server — and from then on it works with the new role.
- **Enabled** switch — turn it **off** to freeze the agent: a disabled account cannot authenticate or
  use the MCP server at all, without deleting anything, and its current session ends the same way.
  Turn it back on to let it sign in again. Save.
- **Rotate Secret** — mints a **new** secret and shows it once (the same one-time panel). The **old
  secret stops working immediately** and the agent's current session ends too, so hand the new one
  to the agent straight away. Use it when a secret leaks or was lost — there is no "show me the
  secret again."
- **Delete** — two-step (Delete → Confirm). Revokes the credential on the spot: no new sign-in and no
  token refresh will succeed (a token the agent already holds runs out on its own within about 10
  minutes).

> **Why a separate kind of account at all?** An AI agent shouldn't hold a person's email and
> password, and it shouldn't be able to quietly grant itself more power. Giving it its own
> credential (rotatable, disable-able, visible in the log under its own name) and a hard rule that it
> can never touch accounts or roles keeps a helpful bot helpful — and keeps humans in charge of who is
> on the team.

## The permission model — why buttons appear or don't

This is the single most useful thing to understand: **the console shows a teammate only what their
role permits.** A missing menu, or a missing **Save / Delete / Rebuild** button, is almost always a
**missing scope**, not a bug or a wrong page — the control simply isn't rendered. So when someone says
"I can't see X," the fix is usually: an owner or admin opens **Organization → Roles**, grants the
right scope (read to see it, write to act on it) — the person is signed out automatically and signs in
again with the new permissions. See `01-the-admin-console.md`.

Two timing rules worth knowing:
- **Role edits** (changing which scopes a role has) and **re-assigning someone's role** take effect
  **immediately**: everyone holding that role (or that one person) is **signed out on the spot** and
  sees *"Your access changed — please sign in again."* on the login page; the new permissions are
  issued when they sign back in. Warn people before you save a role in the middle of their work.
  (An MCP account holding that role loses its session too: within about 10 minutes it has to sign in
  again through the Keen MCP server, and then carries the new permissions.)
- **Role deletion** is immediate too: every account holding the deleted role — human **and** MCP — is
  moved to the **default** role, and the people are **signed out** on the spot, in one atomic step.

One rule sits above roles: an **MCP account** can never manage human accounts, roles, or MCP accounts,
**whatever its role says** — it can never hold `owner` or `admin`, and no other role can be granted
those areas. That is not a scope you can grant; it's how MCP accounts work. Human owners and admins
manage MCP accounts (see above).

## Protected roles

Four roles ship with every organization and **cannot be deleted**: **owner**, **admin**, **developer**,
**default**. Of these, `owner`/`admin`/`default` can't be edited at all; `developer` allows permission
edits but keeps its title locked. `default` is also the landing role for anyone whose role was deleted.
Owner and admin **accounts** are protected too — an admin can't act on an owner or another admin
(no reset, no delete, no role change), only the owner can reset, delete or re-role an admin account,
and even the owner can't change the owner account's role. Nobody can change **their own** role: on
your own account the role select is locked (badge `your account — role locked`).

## Watch out for

- **Owner activation is one-time — and closes on the first submitted email.** The activation screen
  only works while the org has zero accounts (a pending, unconfirmed owner already counts); after
  that it's closed permanently and you reach it by typing `/activate` only while it's still open.
  There is no way to "re-activate", fix a typo'd owner email from the console, or add a second owner —
  everyone else is invited. Check the address before pressing **Send Activation Mail**.
- **"I can't see X" is a permission, not a bug.** Grant the scope in **Organization → Roles**; the
  affected people are signed out at once and get the new permissions when they sign back in. See
  `01-the-admin-console.md`.
- **Never reset a New account's password.** The pending confirmation link is that account's only
  credential — a reset kills it and the reset link refuses unconfirmed accounts, stranding the person.
  The button is hidden on New accounts for exactly this reason.
- **Protected roles and accounts can't be removed.** owner/admin/developer/default roles have no
  Delete; the owner account has no Delete either, and an admin account can be reset or deleted only
  by the owner — an admin trying it on another admin is refused.
- **Deleting a role moves its accounts silently** to `default` — MCP accounts included — and signs
  those people out. Check who holds a role before deleting it.
- **Names are the user's, not yours.** First/last name are set at confirmation and can't be edited from
  the admin surface — the person edits their own under avatar menu → **Account**.
- **An MCP account's secret is shown once** — at creation and after each **Rotate Secret**. Lost or
  leaked it? Rotate; the old one dies the moment you do and the session opened with it ends too, so
  pass the new one on immediately.
- **An MCP account's name is unique and can't be changed.** A duplicate name is refused at create; a
  typo means delete and re-create (new ID, new secret) — so name it carefully.
- **MCP accounts can't manage MCP accounts** (or people, or roles), no matter their role. If a bot
  "can't create an account," that's by design — a human owner or admin does it.
- **Enabled off = the agent is locked out** until you switch it back on. Check it before suspecting a
  broken secret.
