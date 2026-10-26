# Deleting things — what cascades, what unbinds, what's protected

**In one line:** deletion behaves differently per resource — some **cascade** (take other records
with them), some only **unbind** (the record goes, but what it was attached to survives), and a few
are **protected** (can't be deleted at all). Know which before you click the second confirm.

Every delete in the admin is **two-step** (click to arm, click again to confirm) and, unless noted,
**not reversible**. When in doubt, tell the person exactly what will go with it *before* they confirm.

## At a glance

| You delete… | What happens | Takes with it | Protected? |
|---|---|---|---|
| **Account** | that person loses access | nothing else (keys aren't owned by accounts) | the **owner** account can't be deleted; an **admin** account only by the owner (never by another admin) |
| **MCP account** | the AI agent's ID + secret stop working **immediately** | nothing else — its MCP consumers keep working, and any other MCP account with `mcp_consumers` write can manage them | — (only a **human** with `mcp_accounts` write can delete one) |
| **Role** | the role is removed | nothing — its accounts (human **and** MCP) are **moved to the default role** | **owner / admin / default / developer** roles can't be deleted |
| **Space** | the space is removed | **all its agents** (and their settings) — a full cascade | — |
| **Agent** | the agent + its settings are removed | nothing (its space stays) | — |
| **Api Key** | access is **revoked** immediately | its four bound resources are **unbound, not deleted** | — |
| **Client / Certificate / Contract** | that record is removed | **unbinds** from any key it was on (key survives, half-wired); a **Contract** also **releases** its consumers and MCP consumers (see below) | — |
| **Webhook** | that record is removed — but only while **no key holds it** | nothing; the delete is **refused while an api key is bound to it** (unbind it on the key first) | refused while bound |
| **Consumer** | that end user can no longer sign in or refresh (an access token already issued runs until it expires — up to 7 days on today's sandboxes) | nothing | — |
| **MCP consumer** | the AI agent's consumer credential (ID + secret) stops working **immediately** — no new token, no refresh; an access token already issued runs until it expires (up to 7 days on today's sandboxes) | nothing | — (`Delete` on its detail page, two-step, with `mcp_consumers` write; an **MCP account** can delete one via the Keen MCP server too) |

## The details worth saying out loud

**Space → cascade.** Deleting a space deletes **every agent inside it**, along with their Json/Front
settings. This is intentional and cannot be undone — if you need an agent, move or recreate it
elsewhere first. This is the scariest delete; always name the agents that will go.

**Api Key → revoke.** Deleting the key cuts off *everything*: no new application token can be
obtained with it, and — unlike Rotate — **outstanding application tokens are revoked too**. The partner is sent a final notice so its
site re-reads and discovers it's been cut off. The four bound resources (client, certificate,
contract, webhook) are **not** deleted; they simply become free to bind to another key.
> To truly revoke a partner, **delete the key** (or unbind its certificate/contract). **Rotate does
> not revoke** application tokens — see `05-api-access.md`.

**Client / Certificate / Contract → unbind.** Deleting one of these **removes the record** and
**unbinds it** from any API key it was attached to. That key survives as a **partial (half-wired)
row** and stops being "fully bound," so its partner loses access until you bind a replacement. The
partner is notified so it re-reads. Deleting one of these is a common way to accidentally break a live
partner — check whether it's bound to a key first.

**Webhook → refused while bound.** A webhook record that an api key holds **cannot be deleted** — the
console answers `Webhook "…" is bound to an api key. Unbind it there first.` Clear it from the key's
own form (pick `— No webhook —`, Save), then delete the record. An unbound webhook deletes like any
other record.

**Contract → also releases its consumers.** On top of the unbind, deleting a **consumer contract** does
**not** delete the consumers that belonged to it — human consumers and **MCP consumers** alike are
**released** (contract-less). A human consumer becomes an "orphan" an admin can re-assign on its
detail page; a released MCP consumer **can no longer obtain a token** until an MCP account assigns it
a contract again. See `09-consumers.md`.

**Role → reassign, not orphan.** You can't delete any of the four built-in roles — owner, admin,
default **or developer** (the `Delete` button doesn't render for them). Deleting any other role
doesn't leave its people role-less — their accounts, **MCP accounts included**, are **moved to the
default role**, so they keep a (reduced) set of permissions rather than losing access entirely.

**Account.** Removes that team member's login. Keys and resources aren't owned by an account, so
nothing else goes with it. The **owner** account is protected and can't be deleted, and an **admin**
account can be deleted only by the owner — an admin trying it on another admin is refused.

**MCP account.** Removes an AI agent's login: its ID + secret are **revoked on the spot** — the agent
can't authenticate through the Keen MCP server from that moment. Nothing else goes with it; an MCP
consumer belongs to its contract, not to the account that created it — its `Created by` still names
the deleted account, but it keeps working, and any other MCP account with `mcp_consumers` write can
manage it (humans with that write scope keep their three lifecycle controls). Only a **human** with the
`mcp_accounts` write scope can delete one — an MCP account can never delete MCP accounts (or anything
under Accounts / Roles), whatever its role. If you only want to pause the agent, switch **Enabled** off
instead — that's reversible; delete is not. See `02-organization.md`.

**Consumer.** An end user of a partner site can be deleted by an admin, or can delete their own
account through the site's self-service — see `09-consumers.md`.

**MCP consumer.** The AI agent's own consumer identity. Deleting it revokes its ID + secret
**immediately** — it can't sign in again and a refresh is refused; an access token it already holds
keeps working until that token expires. A human with `mcp_consumers` write deletes it from its detail
page in the admin console (`Delete`, two-step confirm); the MCP account that manages it can delete it
through the Keen MCP server as well. Want a pause, not an end? Flip **Enabled** off instead. See
`09-consumers.md`.

**The served copy updates itself.** Whatever you delete, its entry drops out of the ready-to-serve
configuration automatically — you don't rebuild anything. See `07-caches.md`.

## Watch out for

- **Two-step, but still final.** The confirm step is your only guard; deletes don't go to a trash.
- **Space is a cascade** — the agents inside go too. Name them before confirming.
- **Delete vs unbind** — deleting a client/cert/contract doesn't delete the key; it *breaks* it
  (half-wired) and its partner loses access. Rebinding fixes it. A **webhook** can't be deleted at all
  while a key holds it — unbind it on the key first.
- **Revoke = delete (or unbind), never rotate** — if someone wants to cut a partner off, Rotate is the
  wrong lever; it leaves application tokens working.
- **Protected records** — the owner account and the owner/admin/default/developer roles can't be
  deleted; the button won't offer it. An admin account offers `Delete`, but only the owner's works.
- **Deleting an MCP account is instant and final for the agent** — its secret dies on the spot. Want a
  pause, not an end? Flip **Enabled** off instead.
- **You can delete an MCP consumer from the console** — `Delete` on its detail page, two-step, with
  `mcp_consumers` write; the AI agent can do it via the Keen MCP server too. Deleting the
  **contract** doesn't delete them — it releases them (no token until re-assigned).
