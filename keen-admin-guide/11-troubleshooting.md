# Troubleshooting — the everyday "why isn't this working?"

Usage-level problems and their fixes. (Anything about how the platform is hosted or run is out of
scope — that's the engineering team.)

## "It keeps asking for my password every few minutes — can I stop it?"

**Cause:** sessions are time-limited for security. The access token lives **60 seconds** and is
refreshed silently for as long as you keep using the console; after about **11 minutes** of
inactivity (the 60-second token plus a 10-minute idle grace) the in-place password prompt appears
(three wrong attempts send you to the login page). Every sandbox the platform renders uses these
timings.
**Fix:** there's **no toggle** to disable it — it's a security safeguard, not a setting. Staying
active keeps you signed in; the prompt only fires after inactivity, and you continue where you left
off. See `01-the-admin-console.md`.

## "I can't see a menu / a Save / Delete / Rebuild button."

**Cause:** your **role** doesn't grant that permission — the console hides what you're not allowed to
touch, with no error.
**Fix:** an owner or admin grants the scope in **Organization → Roles** (read to see it, write to
act). Everyone holding that role is signed out automatically (*"Your access changed — please sign in
again."*) — they sign in again and the new permissions are there; no refresh needed. See
`01-the-admin-console.md`.

## "The Wake button is greyed out."

**Cause:** the API key isn't **fully bound** — Wake needs all four bindings (client, certificate,
contract, webhook) in place.
**Fix:** open the key, bind the missing ones, Save. Wake lights up. See `05-api-access.md`.

## "Save is disabled."

**Cause:** you haven't changed anything — Save only activates on a real edit (the "dirty" rule).
**Fix:** make a change, or if you meant to leave it, there's nothing to save.

## "The partner can't connect at all — no error, just fails."

**Cause:** the site's browser **Origin** doesn't exactly match the one on the key's Webhook entry.
Origin is matched exactly on `scheme://host[:port]` (the port matters; only 80/443 are omitted; no
wildcards), and a mismatch is **silently dropped** — the caller sees a connection reset or a generic
gateway error, never a helpful one. Two look-alikes: the key is **half-wired** (its Origin isn't
allow-listed until all four bindings are set), or the Webhook was just **edited** and nobody pressed
Rebuild (the new Origin isn't let in until then).
**Fix:** check the Webhook entry's Origin against the site's real Origin, character for character;
confirm all four bindings on the key; then **Rebuild Resource Cache** on the key and **Wake**.

## "The partner's login / registration calls fail with a bare 406 (or 401) and no reason."

**Cause:** usually the key is **half-wired** — one of the four bindings is missing. The partner is
told nothing on purpose: the reason (e.g. `api_key … has no certificate bound`) appears only in the
platform's own log, never in the reply.
**Fix:** it's a wiring task, not a partner outage — bind the missing resource on the key. See
`05-api-access.md`.

## "I lost the API key / client secret / an MCP account's secret."

**Cause:** those are **reveal-once** — shown only at creation (and once per rotation), then stored
irreversibly.
**Fix:** there's no recovery. **Rotate** to mint a new one and hand it over again (for an MCP account:
**Organization → MCP Accounts → the account → Rotate Secret**; the old secret dies immediately, so
give the agent the new one straight away). If the secret **leaked** rather than got lost, know that a
rotate doesn't end a session someone already opened with it — delete the MCP account and create a
fresh one to cut that too (`02-organization.md`).

## "The AI agent says its MCP credentials don't work."

**Check, in order** (all on **Organization → MCP Accounts → the account**):
1. Is **Enabled** on? A disabled MCP account can't authenticate at all.
2. Was the secret **rotated** (or the account **deleted**) since the agent was set up? A rotate kills
   the old secret on the spot — give the agent the new one.
3. Does the **Last login** badge move when it tries? If it does, the credential is fine and the problem
   is **permissions**: the agent sees only what its **role** allows, like a teammate. Grant the scope
   under **Organization → Roles**; it applies at the agent's next authentication.
4. Is it trying to create/change an **account, a role, or another MCP account**? That's refused for
   every MCP account, whatever its role — a human does it. See `02-organization.md`.

## "There's no Create button on MCP Consumers." / "Where are Delete and Rotate?"

**Cause:** no `Create` is by design — MCP consumers are created, assigned their contract + spaces and
given their token by the AI agent (an MCP account) through the Keen MCP server, never from the
console. But `Delete`, `Rotate Secret` and the `Enabled` switch (`Save`) **are** on the detail page —
for holders of the `mcp_consumers` **write** scope; with read only you see none of the three.
**Fix:** to create one, or move it to another contract / spaces, ask the agent (or whoever runs it).
To stop, re-key or remove one, get `mcp_consumers` write and do it from the detail page. See
`09-consumers.md`.

## "How do I reset my password?" / "I reset it and now I can't log in!"

**How a reset works:** there's no "forgot password" link on the login screen. Two ways in: an
**admin** (or the owner) opens **Organization → Accounts → your account** and clicks
**Reset Password**; or, while you're signed in, you do it yourself from the avatar menu →
**Account → Password → `Send Reset Mail`** (this one works for everyone, the owner included). Either
way the old password **stops working immediately** and a link is emailed to you. You open the link,
set a **new** password, and then log in with the new one.

**So "I reset it and can't log in" is almost always one of these:**
1. **You haven't finished the email link yet.** The moment a reset is triggered the old password is
   dead — but a new one only exists once you open the emailed link and set it. Until then, *neither*
   password works. Open the reset email and set a new password.
2. **You're still typing the old password.** Use the **new** one you set via the link.
3. **The reset link expired or was already used** (links are single-use and time-limited). The
   password is invalidated but no new one is set → ask an admin to **Reset Password** again for a
   fresh link.
4. **Your account is still "New" (not confirmed).** The console hides Reset Password for
   unconfirmed accounts (a reset would kill the pending confirmation link — the server itself does
   not refuse it) — use your original **confirmation** link instead, not a reset. If it expired, an
   admin re-invites you.
5. **You're the owner.** No admin can reset the owner's password for them; while signed in, the
   owner uses **Account → Password → `Send Reset Mail`**. Locked out with a forgotten password → the
   initial setup path / support, not this button.

> Don't confuse this with the **inactivity prompt** that asks for your password mid-session — that
> wants your *current* password, and if you just reset it, use the **new** one. See
> `01-the-admin-console.md`.

## "My agent doesn't respond."

**Check, in order:**
1. Is the agent **Active**? (the switch on its detail page)
2. Do its **Start Flow** and **Start Node** exactly match a real flow file + start node in the
   deployed project? They must be **PascalCase** and match by name. A guessed / made-up value (e.g.
   someone typed `main` / `start` just to fill the field) is accepted by the form but points at
   nothing — so the agent has nothing to run. See `03-spaces-and-agents.md`.
3. Is its **project deployed** into the space? (`04-deploy-a-project.md`)
4. Is a **client actually connected** to it? Chat only happens through a connected site
   (`06-connect-a-partner-site.md`) — there's no chat box in the admin.

## "A partner is showing stale configuration."

**Cause:** their site hasn't re-fetched since your change.
**Fix:** the served copy is already fresh (it refreshed on your save), so the partner just needs to
re-read — press **Wake** on the key to nudge them. You do **not** normally need to rebuild a cache
for this — except after a **Webhook** edit, which reaches the served copy only through a Rebuild. If
you changed several things bound to that key and want to be certain, do the two-click
routine on the key's page: **Rebuild Resource Cache** (on an api key it refreshes everything bound
to it), then **Wake**. See `08-wake.md`.

## "Create fails with 'Reached the maximum number of…'."

**Cause:** you hit the org-wide cap for that resource (e.g. 20 API keys).
**Fix:** delete one you don't need, then create.

## "Reset password isn't available / does nothing."

**Cause:** the console offers it only on **confirmed, non-owner** accounts (the server does not
enforce the confirmed rule — resetting a `New` account by a direct API call, outside the console,
kills its confirmation link; the Keen MCP server can't reset accounts at all).
**Fix:** confirm the account first; the owner resets their own from **Account → Password**.

## "I want to debug what's happening in production."

**Cause:** the debuggers are **sandbox tooling** — don't count on one where real users are served.
**Fix:** reproduce it in a **sandbox** and debug there. Sandboxes are the build-and-test environment;
production serves real users. See `10-flows-and-debugging.md`.

---

_When none of these fit, say so plainly and escalate to the engineering team rather than guessing —
especially anything about hosting, uptime, or how a service behaves under the hood._
