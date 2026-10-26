# Consumers — the end users of a partner site

**In one line:** a **consumer** is an end user of a partner's website — not a teammate. Each consumer
belongs to exactly one **tenant** (a consumer contract), and everything about it — login, spaces,
even email uniqueness — is scoped to that tenant.

## What is a consumer? (and how it differs from an account)

An **account** (`02-organization.md`) is one of *your* people, signing into the admin console. A
**consumer** is one of a *partner's* people — a visitor to the partner's site who registers, logs in,
and chats with your agents through that site. The two populations are completely separate and never
mix, **even when they share an email address**. A consumer never sees the admin console; an account
never chats as a consumer.

A consumer record carries: email, an irreversibly-hashed password, first/last name, gender, date of
birth, a consent flag, the list of **spaces** it may use, a **confirmed** status, and an **external**
marker (set when it came from a partner sign-up; an admin invite leaves it empty).

## Tenant scoping — the load-bearing rule

Each partner site is a **tenant**, represented by a **consumer contract**. Every consumer belongs to
**at most one** tenant, and:

- **Email is unique *per tenant*, never across tenants.** The same address can hold one account under
  partner A, another under partner B, and a first-party account — all independent, with their own
  passwords, profiles and space grants.
- **A consumer only ever sees its own tenant's spaces.** At login the effective space set is the
  account's own list **intersected** with the tenant's currently-allowed spaces, and every chat run
  re-checks the tenant's **current** spaces — so a space revoked from a tenant stops working
  immediately, not at the next login.
- One tenant can never read or authenticate another tenant's users; the tenant is resolved from the
  partner's own credentials on every call.

A **first-party** consumer is a special case: created in the console with no contract. No contract
means **no policy at all** — no one-time passcode, no block rules — and its spaces aren't clamped by
a contract.

## Registration: system vs outside

There are two ways a consumer comes to exist, and the **external** marker records which: it is set
on partner sign-ups, and **every consumer without it counts as in-app** for the contract's policy.

**Outside registration** is partner-driven and follows a *request → email → confirm* handshake —
nothing is created until the user proves they own the address:

1. The partner's server submits the registration (its application token, the user's details, and the
   email-link target). KeenAgents refuses this if the tenant's **outside-registration** policy is off —
   each tenant can be gated on its own.
2. The password is hashed, the details are sealed so only this tenant can read them, and a verification
   email is sent. The plaintext password never rides the link.
3. The user clicks the link and the partner site completes the confirmation step.
4. KeenAgents re-checks the tenant's **outside-registration** policy and the key's bindings (a
   change between the request and the click takes effect on this very step), validates the link and
   its expiry, and creates the account **already confirmed** and marked external, with spaces seeded
   from the contract's default outside-registration set.

**System registration** is an **admin invite** from the org console (Ai → Consumers → Create): the
admin enters the email and picks the **tenant** it belongs to — or none, for a first-party consumer —
the account is created unconfirmed, an activation mail goes out, and the user sets name + password on
the confirmation page. Two things to know about such a consumer:

- **It is "in-app" for the policy.** It carries no partner sign-up marker, so the contract's two
  in-app rows — *One-time code — consumers created in-app* and *Freeze in-app-created consumers* —
  apply to it. (Its detail page shows neither a `Partner sign-up` nor an `In-app` badge — today the
  `In-app` badge doesn't appear on any consumer, so "no badge" is what in-app looks like.)
- **It starts with no spaces.** The contract's **In-app default** column is saved but not applied
  today, so grant its spaces yourself on the consumer's **Spaces** board. (Partner sign-ups *do* get
  the **Partner default** spaces.)

**MCP consumers** (below) are outside all five policy rows: never a one-time code, never frozen by
the policy — only the contract's spaces limit them.

## Authentication (usage level)

Consumer sign-in uses the same **two-token** model as the rest of the partner integration: the
partner's server holds a long-lived **application token**, the browser holds a per-user **access
token** that expires (see Refresh below), and both are checked together on every consumer call. Two things an operator should know:

- **One-time passcode.** Where the tenant's policy requires it, login returns a "Verify" challenge and
  emails a **6-digit passcode** instead of signing the user straight in. It's short-lived and
  single-use.
- **Refresh.** The browser's access token lasts a limited time (7 days on today's sandboxes); the
  site refreshes it in the background. A refresh **spends** the old refresh token, so the partner
  serializes refreshes (two at once make one fail).

The full wire-level detail (headers, the passcode confirm step, refresh semantics) belongs to the
partner integration — see `06-connect-a-partner-site.md`.

## Self-service (what a consumer does to its own account)

A partner site runs these **on behalf of a logged-in consumer**:

- **Profile edit** — update name, gender or date of birth (partial: a blank field never wipes a stored
  value; email can't be changed here). Authorized by the live login alone.
- **Password reset / change** and **account delete** — the sensitive ones. These use a
  **claim → email → redeem** handshake: the first request changes nothing and emails a single-use link;
  only redeeming that link performs the change. A forged or replayed link can never change an account on
  its own.

### Forgot-password, end to end

1. The site submits a **reset claim** with the user's email and the **new** password.
2. KeenAgents hashes the new password, records a single-use reset grant, and emails a confirmation link.
   **Nothing has changed yet.**
3. The user clicks the link; the site redeems it. KeenAgents validates it, applies the new password, and
   consumes the grant in the same step.
4. A replayed or expired link finds no grant and is refused — claim again to get a fresh one.

## The admin side (managing consumers in the console)

Consumers are managed under **Ai → Consumers**. Viewing needs the `consumer` scope; every change
also needs its **write** grant. The list is a paged, filterable table; each row opens a consumer's
detail page, where an admin can:

- **Create a consumer** — enter an email and pick the **tenant** it belongs to (or none, for a
  first-party consumer). A confirmation link is emailed on save.
- **Move it to another tenant** — the **Contract** select. Picking a different contract **re-binds** the
  consumer and **clamps its spaces** to the new tenant's allowed set; the button reads **Save Contract**.
- **Unbind it** — choosing "no contract" removes its tenant and **clears every space**; because that
  destroys a grant with nothing to replace it, it's a two-step **Confirm unbind** (with **Keep current
  contract** to back out).
- **Change its spaces** — a separate spaces board with its own Save (which spaces, within the tenant's
  allowed set, this consumer may use).
- **Reset Password** — the console offers it only on **confirmed** consumers; it emails a reset and
  kills any earlier link. (The server itself doesn't check — a reset sent to a `New` consumer by a
  direct API call, outside the console, would kill its pending confirmation link. The Keen MCP server
  can't send one at all: MCP accounts can't reset human consumers.)
- **Delete** — a two-step control.

> **Deleting a contract does not delete its consumers** — they're **released** (they become "orphans":
> marked as partner sign-ups but with no tenant). The consumer's detail page is where an admin
> re-assigns each one to a contract. An `Orphan` badge tells a released partner sign-up apart from a
> plain first-party consumer, because "no tenant" means two different things — but a released
> consumer that an admin had created carries no sign-up marker, so it shows `No tenant`, exactly like
> a first-party one. The contract's **MCP consumers** (next
> section) are released the same way — contract-less, they can't obtain a token until an MCP account
> assigns them a contract again.

**If the "admin" is an AI agent:** an **MCP account** (`02-organization.md`) signed in through the Keen
MCP server can only **view** the consumers on this page. It cannot create, reset, move, assign spaces to,
or delete a human consumer — whatever its role. The consumers it manages are its own kind, below.

## MCP consumers — the agent's own consumers

An **MCP consumer** is the mirror of an MCP account on the consumer side: a consumer **for an AI
agent, not a person**. When an agent needs to chat with your agents the way a site visitor would — to
test a flow, run a job, drive a conversation — it doesn't borrow a human's login; it makes itself an
MCP consumer. Compared with a normal consumer it is **headless**:

- **No email, no password, never a one-time passcode.** Its credential is an **ID + a secret**, and
  the secret can be rotated.
- **It belongs to a consumer contract** (a tenant, like any consumer) and has **spaces** — a subset of
  that contract's spaces — plus an **Enabled** switch.
- **Its login token comes only through the Keen MCP server** — never through a partner site's login
  page, and never with an OTP step.

**Who manages them — and who doesn't.** MCP consumers are **provisioned by MCP accounts** (the AI
agent) through the Keen MCP server: create, assign the contract and spaces, and obtain their token —
a human token is refused (403) for any of those. The admin console never creates one, on purpose:
under **Ai → MCP Consumers** (right after Consumers; visible with the `mcp_consumers` read scope) you
get a list and, per consumer, a detail page showing its **ID** (copy button), **name**, **contract**,
**spaces**, **enabled** state, **last login**, and **created by** — the MCP account that made it.
(`Created by` is a record, not an owner: **any** MCP account with `mcp_consumers` write can manage
every MCP consumer in the organization, so when an MCP account is deleted its consumers keep working
and another MCP account can take them over.) Name, contract and spaces are read-only there, and
there is **no Create** page. What a human *does*
get, with the `mcp_consumers` **write** scope, are the three **lifecycle** controls — the same three
the agent has: the **Enabled** switch (`Save`), **Rotate Secret** (the new secret is shown once; the
old one stops at once), and **Delete** (two-step confirm).

> **Why can I stop one but not make one?** Because they are the agent's working identities: the
> agent that made one is the one that knows its purpose and holds its secret, so creation, the
> contract and the spaces stay with the agent. But a compromised or abandoned consumer must be
> stoppable **without a bot** — so any admin with write can flip it off, re-key it (the secret the
> agent stored stops working; it needs the new one) or remove it. Prefer **Enabled** off when you
> only want a pause. Know how far each one reaches: **Delete** stops any new token and any refresh
> for good; **Enabled** off does the same for as long as it stays off; **Rotate Secret** only retires
> the secret — a session the agent already holds keeps refreshing. None of the three stops an access
> token already issued: it keeps working until it expires (up to 7 days on today's sandboxes). For a
> compromised consumer, delete it — don't rely on a rotate.

Everything else about tenancy holds for them exactly as for humans: they see only their contract's
spaces, a space revoked from the contract stops working for them immediately, and they never cross
tenants.

Moving or unbinding a consumer signs its current session out — the partner site is notified and the user
logs in again. (The sign-out is the partner site's job: a site that ignores the notice keeps the old
session until its access token expires.) Whenever an admin changes a consumer's spaces or tenant,
the partner is nudged via **notify-then-fetch** (`08-wake.md`), and the expected reaction is a
**re-login**, since a consumer's entitlements are fixed into its session when it signs in.

## Watch out for

- **Consumers are not accounts.** An admin account and a consumer are separate identities even with the
  same email. Don't manage one expecting the other's rules.
- **The contract's policy decides what's allowed.** Whether outside registration works, whether a
  one-time passcode is required, which logins are blocked, and which spaces new consumers get — all live
  on the tenant's **consumer contract** (`05-api-access.md`), not on the consumer.
- **Registration gating is per tenant — there is no org-wide switch.** The tenant's
  outside-registration toggle gates both the *start* and the *completion* of a partner sign-up (it is
  re-checked when the link is redeemed). The one-time passcode is the same: the contract's two OTP
  flags alone decide, and a consumer with no contract never gets one. "In-app" means every consumer
  not marked as a partner sign-up — including the ones an admin creates here; MCP consumers are
  never touched by the OTP or freeze rows.
- **A consumer you create here starts with no spaces** — the contract's *In-app default* column is
  not applied today. Grant them on its Spaces board.
- **Tenant isolation is absolute.** A consumer only ever reaches its own tenant's spaces. A consumer
  who "can log in but nothing works" usually has an **empty space intersection** — compare the tenant's
  allowed spaces against the account's spaces.
- **Unbinding clears all spaces.** Removing a consumer's contract leaves it reaching nothing until an
  admin gives it a contract again — that's why it costs a confirm.
- **Reset Password is only offered on confirmed consumers.** On a New (unconfirmed) one it would kill
  the pending confirmation link — the console hides it for that reason; the server does not refuse it
  — the same trap as admin accounts (`02-organization.md`).
- **Humans can't create or assign MCP consumers in the console** — no Create page; name, contract and
  spaces are read-only. The AI agent (an MCP account) provisions them through the Keen MCP server.
  With the `mcp_consumers` write scope a human **can** enable/disable (Save), rotate the secret and
  delete one from its detail page.
- **An MCP account can only *view* human consumers.** If a bot reports it "can't create / reset / move
  a consumer," that's by design — a human with the `consumer` write scope does it, or the bot makes
  itself an MCP consumer instead.
- **MCP consumers never get a passcode and never log in through the partner site.** Their token comes
  only via the Keen MCP server. Don't try to "log one in" on the website.
- **Deleting a contract releases its MCP consumers too** — contract-less, they can't obtain a token
  until an MCP account re-assigns them.
