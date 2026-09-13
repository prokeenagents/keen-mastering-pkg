# Limits & permission scopes

Two reference tables people ask for constantly: **how many / how long can this be**, and **what does
a role's read vs write actually unlock**.

---

## Part 1 — Creation limits & field caps

These are enforced in the forms; hitting a count cap fails the create with a "…limit reached / Reached
the maximum number of…" message. Delete one first, then create.

### How many you can have

| Resource | Limit | Scope of the limit |
|---|---|---|
| Spaces | **20** | organization-wide |
| Agents | **10** | **per space** (not org-wide) — see the note below |
| API Keys | **20** | organization-wide |
| Clients | **20** | organization-wide |
| Certificates | **20** | organization-wide |
| Consumer Contracts | **20** | organization-wide |
| Webhooks / Accounts / Roles / Consumers | no fixed small cap | grow with your partners / team / tenants |

> **Agents are capped per space (10), not globally.** So an "agent that isn't in a space" doesn't
> exist — every agent belongs to exactly one space, and each space holds up to 10. If you need more,
> use another space. (See `03-spaces-and-agents.md`.)

> **The 20-space cap is a raisable quota, not a hard ceiling.** Twenty is a *default*, chosen because each
> space keeps a live, always-warm copy of its configuration so agents resolve instantly — and that warm set
> grows with the number of spaces, which is the only reason a default exists. It can be raised: at real scale
> an organization is better served by **dedicated capacity** for its spaces than by a higher shared number, so
> if twenty is tight it's a provisioning conversation, not a wall. (The other org-wide 20s are plain count caps.)

### Field formats & length caps

| Field | Rule |
|---|---|
| **Agent ID (slug)** | kebab-case (lowercase **letters only** — no digits — joined by single dashes), **3–100** chars |
| **Agent display name** | required, **3–150** chars |
| **Start Flow / Start Node** | **PascalCase** (capital first, letters+digits, no dashes), **3–60** chars each |
| **Agent Json / Front Settings** | up to **1,000,000** characters each |
| **API Key name** | required, up to **100** chars, unique |
| **Client name** | required, **1–100** chars, unique |
| **Certificate name** | required, up to **100** chars, unique; optional **shared secret key 16–32** chars (left empty = no secret, shown as `Unset`) |
| **Consumer Contract name** | required, up to **100** chars, unique |
| **Consumer Contract key** | exactly **19** characters (A–Z, a–z, 0–9) — the tenant identifier, whether you type it or let it be minted |
| **Webhook name / Origin / URL** | name up to **100** chars; Origin `scheme://host[:port]` (no path, no trailing slash; up to 200); URL a full `http(s)://` address up to 500 — all three unique |
| **Space title / description** | both required and **unique**; description up to **500** chars |
| **Role name** | required, unique, up to **60** chars; it may not be — or contain — `admin`, `owner`, `developer` or `default` |
| **Account email** | required, valid email, **globally unique** across the organization (the per-tenant email rule is for *consumers*, not admin accounts) |
| **MCP account name** | required, **unique** across MCP accounts (a duplicate is refused), and **immutable** — read-only after create; a wrong name means delete + re-create |

If a colleague asks "why won't it save," it's almost always one of these rules — check the exact field
message on screen (it names the cap).

---

## Part 2 — What a role's read vs write unlocks

A role is a set of **permission scopes**. Each scope you grant has two levels:

- **Assigned (read)** — you can **see and open** that area: its sidebar entry appears, you can view the
  list and the detail pages and read the values.
- **Write** — you can **act**: create, edit, save, delete, and use that area's action buttons.

**Rule: write always requires read.** You can't grant write on a scope without also granting read —
the form keeps the two in step (turning write on turns read on; turning read off turns write off).

**No grant = invisible.** Without read on a scope, that whole area (and its buttons) simply **doesn't
appear** — it's not an error, it's just not there. This is why "I can't see X" is almost always a
missing scope. (See `01-the-admin-console.md`.)

**Owner and admin see everything** regardless of individual scopes — they are the protected roles.

**One thing no scope changes:** an **MCP account** (an AI agent's login, `02-organization.md`) can
never create, change or delete human accounts, roles, or MCP accounts — not even with the `admin`
role. That's a property of *being* an MCP account, not a scope you can grant or remove.

### The scopes (14) and what each governs

| Scope | Read (Assigned) lets you… | Write lets you… |
|---|---|---|
| **roles** | see roles & the permissions board | create / edit / delete roles |
| **account** | see the team's accounts | invite / edit / delete accounts, reset passwords |
| **consumer** | see the end users of partner sites | create / edit / delete consumers, change their spaces |
| **spaces** | see spaces | create / edit / delete spaces, reset deployment tokens |
| **agents** | see agents | create / edit / delete agents, edit their settings |
| **api_keys** | see API keys | create / edit / delete keys, rotate, Wake |
| **clients** | see clients | create / edit / delete clients, rotate secrets |
| **certificates** | see certificates | create / edit / delete certificates, rotate, generate secret |
| **contracts** | see consumer contracts | create / edit / delete contracts, set policy & spaces |
| **webhooks** | see webhook entries | create / edit / delete webhook entries |
| **cache** | see cache status (the Cache page) | Rebuild / Invalidate caches, incl. the per-record **Rebuild Resource Cache** button |
| **logs** | read the audit trail & log files, list Log Records, reveal a record's stream token | toggle which log channels are on; create / edit / pause / delete **Log Records** (the per-space / per-agent logs) |
| **mcp_accounts** ("MCP Accounts") | see MCP accounts — the AI agents' logins | create them, assign their role, enable/disable, rotate the secret, delete them (**humans only** — an MCP account never gets these, whatever its role) |
| **mcp_consumers** ("MCP Consumers") | see MCP consumers in the console (the consumers an AI agent made for itself) | lets an **MCP account** provision them — create, assign their contract + spaces, enable/disable, rotate, delete, mint their token — through the Keen MCP server. A **human** with this write scope gets the three lifecycle controls in the console: enable/disable (Save), rotate the secret, delete — never create or assign |

> **The Rebuild Resource Cache button** (on every record page) is gated by **cache write** —
> *separately* from the record's own scope. So a person can have, say, `agents:w` and still not see
> Rebuild if they lack `cache:w`, and vice-versa. (See `07-caches.md`.) The api-key page's cascade
> version of the button is gated the same way.

### Reading a compact permission string

You may see a role's permissions written compactly (each area with a level: 0 none, 1 read, 2 write).
It's just this table in short form — a person is allowed an action only if their level for that scope
is high enough (read to see, write to act). Owners and admins pass everything regardless.

The areas appear in a fixed order, each as a short indicator followed by its level: `a` account,
`cs` consumer, `r` roles, `sp` spaces, `ag` agents, `ak` api_keys, `ct` clients, `ca` certificates,
`co` contracts, `wk` webhooks, `ce` cache, `l` logs, and then the two newest at the **end** — `mc`
mcp_accounts, then `mcc` mcp_consumers. A full grant on all fourteen reads
`a2cs2r2sp2ag2ak2ct2ca2co2wk2ce2l2mc2mcc2`; an area that's missing from the string counts as 0.

## Watch out for

- **Write implies read** — you never grant write alone; the form couples them.
- **"Can't see it" = missing read**, not a bug — grant the scope in Roles.
- **cache write is its own scope** — needed for every Rebuild/Invalidate control, independent of the
  resource's own permission.
- **Caps are org-wide 20 for most API/space resources, but agents are 10 per space** — don't quote a
  global agent number.
- **`mcp_consumers` write provisions for the agent, polices for you.** It's the scope that lets an
  **MCP account** create MCP consumers, assign their contract + spaces and mint their token via the
  Keen MCP server. Granting it to a human role adds exactly three console buttons — the **Enabled**
  switch (Save), **Rotate Secret** and **Delete** — so an admin can stop, re-key or remove a
  compromised or abandoned consumer without a bot; it never adds Create or assign.
- **No scope makes an MCP account able to manage accounts, roles or MCP accounts.** If a bot reports
  "permission denied" on those, it isn't a missing grant — it's the rule.
- **MCP account names are unique and permanent** — a duplicate is refused; a typo can't be edited
  away, only deleted and re-created (which mints a new ID + secret).
