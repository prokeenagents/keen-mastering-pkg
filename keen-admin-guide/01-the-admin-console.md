# The admin console — finding your way around

**In one line:** the admin console is the web app where you do everything. The sidebar is the map,
and you only ever see the parts your **role** lets you.

## The layout

The left sidebar has four groups (the titles are rendered exactly like this — "Ai" and "Api", not
"AI"/"API"). Each entry below is the exact label you'll see:

- **Organization** — **Accounts**, **MCP Accounts** (logins for AI agents, not people), **Roles**.
  Your team and what they can do.
- **Ai** — **Spaces**, **Agents**, **Consumers** (the end users of partner sites), **MCP Consumers**
  (the consumers an AI agent created for itself — here you can disable, rotate or delete one, not
  create). The agents you build, where they
  live, and who chats with them.
- **Api** — **Api Keys**, **Clients**, **Certificates**, **Contracts**, **Webhooks**. How outside
  partners get access.
- **System** — **Logs**, **Log Records**, **Cache**. The audit trail and the served-configuration
  cache controls.

An entry only shows up if your role can *read* that area; a group whose entries are all hidden
disappears together with its title. (Agent settings are not a menu entry — they're pages reached
from an agent's detail page, `03-spaces-and-agents.md`.)

Most sections work the same way: a **list** page (all the records) → **Create** to add one → click a
record in the list (its email / name / title is the link) to open its **detail** page, where you
edit, act, and delete.

Top-right, your **avatar** opens a small menu: **Account** (your own page — change your first/last
name, or send yourself a password-reset mail with **Send Reset Mail**) and **Logout**.

## Patterns you'll see everywhere

- **Create → list → detail.** Learn it once; every resource follows it.
- **Save only lights up when you've actually changed something** (a "dirty" form). If Save looks
  disabled, you haven't changed anything yet.
- **Delete is two-step** — a click to arm it, a second to confirm. Deletes can cascade (a space takes
  its agents; deleting a bound client, certificate or contract unbinds it from its Api Key — a bound
  **webhook** can't be deleted at all until you unbind it on the key). The page tells you.
- **Some secrets are shown once** — a new API key, a client secret, an MCP account's secret. Copy
  them the moment they appear; they cannot be recovered, only rotated.
- **Copy buttons** — IDs and tokens have a one-click copy (Space ID, Agent ID, Api Key ID, MCP
  Account ID, deployment token).

## "Why can't I see X?" — it's your role

The console shows you **only what your role permits**. Each area has a permission scope; without the
right grant, the menu entry, and specific controls like **Rebuild Resource Cache**, **Save** or
**Delete**, simply **aren't rendered** — there's nothing to click. (If someone types the page's
address directly, they get a plain notice instead of the page: *"You don't have permission to view
this page"* with a **Back to Home** button — no data, no error trace.)

So if a teammate says "I don't have that menu" or "I can't see the Save/Delete/Rebuild button":

1. It's almost always a **missing permission**, not a bug or a wrong page.
2. An **owner** or **admin** opens **Organization → Roles**, edits that person's role (or their
   account's role), and grants the scope — read to see it, write to act on it.
3. The moment a role's permissions are saved, everyone holding that role is **signed out
   automatically** (they see *"Your access changed — please sign in again."* on the login page).
   They sign in again and the new permissions are in effect. No manual refresh needed — and no way
   to keep the old session. The same happens when you change one person's role on their account.
   (An MCP account picks the change up at its next token refresh instead.)

The **owner**, **admin**, **developer** and **default** roles are **protected** and can't be
deleted; owner/admin/default can't be edited at all, and developer keeps its name (only its
permissions can change).

## Signing in

You log in with your account email and password. The very first account, the **owner**, is created
through a one-time activation screen — see `02-organization.md`.

### "Why does it keep asking for my password? Can I turn it off?"

Your session is **time-limited on purpose** — it's a security safeguard. While you're active,
navigation quietly keeps you signed in; but after a stretch of **inactivity** a small panel titled
**Session Expired** appears in place (with a blurred backdrop): your email is already filled in and
locked, you type your password and press **Sign In** to carry on. You **don't lose your spot** — you
continue exactly where you were.

- **Today's real numbers (every environment):** the sign-in itself is refreshed silently as long as
  you keep using the console; the prompt appears after about **11 minutes of doing nothing** (a
  1-minute access window plus a 10-minute idle grace). If you stay away for **2 days**, the session is
  over for good and you land on the login page. There is no separate "long production session"
  today — making production sessions longer is a configuration decision for the engineering team,
  not something you can set in the console.
- **Can you stop it?** **No — and you shouldn't want to.** It's a platform security behavior, not a
  setting in the admin console; there's no toggle to disable it. Staying active keeps you signed in;
  it's the idle gaps that trigger the prompt.
- **Three things end the session instead of unlocking it** — you'll land on the **login page**:
  typing a **wrong password three times** in the prompt; **reloading or navigating** while the prompt
  is showing (don't press F5 — just enter the password); and being away longer than the 2-day
  window. The prompt's small **Go to sign in** link does the same on purpose (use it if a *different*
  person needs to sign in). In every case just log in again; nothing is lost.
- You can also be sent to the login page with the notice *"Your access changed — please sign in
  again."* — that's not a timeout, it means an admin changed your role (or your role's permissions)
  and your session was ended so the new permissions apply. Sign in again.

## Watch out for

- **"It's broken" is usually "I don't have permission."** Check the role before you chase a bug.
- **A greyed-out button means a precondition isn't met**, not that the feature is missing — e.g.
  **Save** needs a change, **Wake** needs a fully-bound key with no unsaved edits. Some controls are
  not greyed but simply **absent** until their precondition holds — **Reset Password** only exists
  on confirmed, non-owner accounts, and **Delete** never appears on the owner account.
- **Nothing you do here touches how the platform is hosted or run** — that's the engineering team's
  world, and out of scope for this guide.
