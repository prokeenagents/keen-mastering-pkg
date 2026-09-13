# Screen reference — what's on every page

**In one line:** a page-by-page map of the admin console — for each screen, the panels, fields,
buttons and table columns you actually see, and exactly where each control sits.

**How to use this:** this is the detailed companion to `01-the-admin-console.md`. When a colleague
asks "where is the button to X," find their section below and read them the exact label and its
location. Every section works the same three-layer way, so learn the shape once:

- **Landing page** (e.g. `/spaces`) — a header card, plus a **Create X** card (with a
  brand-coloured `Create X` button) and a **View X** card (button to the list). The `Create X` card
  only appears if your role has that section's **write** scope.
- **List page** (`/…/list`) — the table of records. Open it from the landing page's **View X**
  button. Click a row's **Visit** link (right-hand column) to open one.
- **Create form** (`/…/create`) and **Detail page** (`/…/[id]`) — where you add and then edit,
  act on, and delete a record.

Two patterns repeat on nearly every **detail** page, so they're stated once here and not re-listed:

- **Footer buttons:** `Save` (greyed until you actually change something), often a
  `Rebuild Resource Cache` button (see *System → Cache*), and `Delete`. **Delete is two-step** — the
  first `Delete` arms it, then `Confirm delete` (red) + `Cancel` appear.
- **Copy controls** are small icon buttons sitting to the left of a read-only field (IDs, tokens,
  keys, public certificate). Each shows a toast like "… copied" when clicked.

Controls you don't have permission for **simply aren't rendered** — an absent button is almost
always a missing role scope, not a bug.

---

## Organization → Accounts

**List page** (`Account List`). Columns: `Name`, `Email`, `Role`, `Status`, `Created At`, and a
`Link` column whose cell is a **Visit** link. Every column except `Link` sorts — click the header to
cycle ascending → descending → off. **No search box**; filtering is a repeatable-row panel with
`Type` / `Operator` / `Value` columns, an `Add Filter` button, `Clear All`, and `Apply`. The `Status`
cell shows a `New` badge (unconfirmed) or `Active` badge (confirmed). Footer counter reads
`Showing X–Y of Z`. Empty states: `No accounts on this page.` / `No accounts match the filters.` The
`Create Account` button lives on the landing page's create card.

**Create form** (card `Account Details`). Fields: `Email` (required, placeholder
`user@company.com`) and `Role` (a select, placeholder `Select a role`; the `owner` role is never
offered). Submit button: `Create`. On success it opens the new account's detail page.

**Detail page** (card `Role & Access`). Badges at the top show the role, `Active`/`New`, and — for
platform accounts — `protected — read only` (owner) or `protected — role locked` (admin). Fields:
`Email` (read-only), `Name` (read-only; shows `— not confirmed yet —` until the user sets it), and
`Role` (the one editable field). Footer buttons (writers only): `Save`, `Reset Password` (only for a
**confirmed** account that isn't the owner), and `Delete` → `Confirm delete` + `Cancel`. The owner is
fully locked; admin has its role select locked but can still be reset/deleted. **No copy buttons on
this page.**

---

## Organization → MCP Accounts

Logins for **AI agents**, not people (`02-organization.md`). The sidebar entry sits between Accounts
and Roles and appears with the `mcp_accounts` **read** scope; creating, saving, rotating and deleting
need its **write** scope. Only humans use this page — the console refuses an MCP account's token here
outright (an MCP agent can *list* MCP accounts through the MCP server, never change one).

**List page.** Columns: `Name`, `Role`, `Enabled`, `Created`, `Last login`, and a `Link` (Visit). The
`Create MCP Account` button lives on the landing page's create card.

**Create form.** Fields: `Name` (required; **unique** across MCP accounts and **permanent** — it can't
be changed afterwards), `Role` (a select; the `owner` role is never offered), and an `Enabled` switch
(on by default). Submit: `Create`. Afterward the form is replaced by a **one-time secret panel**
(`MCP secret — shown once`): the account's `MCP Account ID` and its `MCP Secret`, each with a copy
button, and the button `I have copied it — open the account`. **Copy the secret here — it is never
shown again.**

**Detail page.** Read-only `MCP Account ID` (copy icon) and read-only `Name`; an editable `Role`
select; an `Enabled` switch (off = the account cannot authenticate or use the MCP server); a
`Last login` badge showing when the agent last signed in. Footer (writers only): `Save` (role /
enabled — a role change applies at the account's next authentication), `Rotate Secret` (**a single
click — no confirm step**: it mints the new secret on the spot and shows the same one-time panel,
dismissed with `I have copied it — back to the account`; the old secret stops working immediately),
and `Delete` → `Confirm delete` + `Cancel`.

---

## Organization → Roles

**List page** (`Role List`). Columns: `Title`, `Slug`, `ID`, `Created At`, and a `Link` (Visit)
column. Sortable headers; the same `Add Filter` / `Clear All` / `Apply` panel (types: title, slug,
id, created at). **Roles are unpaginated — no "Showing X of Z" footer.** Empty states:
`No roles yet.` / `No roles match the filters.` The `Create Role` button is on the landing page.

**Create form** (card `Role Details`). One field: `Title` (required, placeholder `Enter Role Title`).
Permissions aren't set here — you set them on the detail page after creating. Submit: `Create` →
opens the new role.

**Detail page** (card `Role & Permissions`). Badge `protected — read only` for built-in roles,
`protected — title locked` for `developer`. Field `Title`, then a **Permissions** section: the
**permissions board**, one row per area with two coupled switches — `Assigned` (grants read) and
`Write`. `Write` is disabled until `Assigned` is on; turning `Assigned` off clears `Write`. The
fourteen rows are: `Accounts`, `Consumers`, `Roles`, `Spaces`, `Agents`, `API Keys`, `Clients`,
`Certificates`, `Contracts`, `Webhooks`, `Cache`, `Logs`, `MCP Accounts`, `MCP Consumers` (each with
a one-line description of what read vs write grants). Footer (writers only): `Save` and `Delete` →
`Confirm delete` + `Cancel`. `admin` / `owner` / `default` are fully locked; `developer`'s title is
locked but its scopes stay editable. None of the four built-in roles can be deleted — the `Delete`
button doesn't render for them.

---

## Ai → Spaces

**List page** (`Space List`). Columns: `Title`, `ID`, `Agents Count` (sortable), and a `Link` column
whose cell reads **Visit**. No filter panel — sort via the headers. Empty state: `No spaces yet.` The
`Create Space` button is on the Spaces landing page.

**Create form** (card `Space Details`). Fields: `Title` (required, placeholder `Enter Space Title`)
and `Description` (required, placeholder `What is this space for?`) — both must be unique. Submit:
`Create`.

**Detail page** (card `Space Configuration`). Editable fields `Title` and `Description`. Then two
read-only fields, each with its own copy icon and (for the token) a reset button:
- `Deployment Token` — copy icon (aria `Copy deployment token`) + a `Reset Token` button (writers
  only); resetting mints a new token and kills the old one immediately.
- `Space ID` — copy icon (aria `Copy Space ID`).

Footer: `Save`, `Rebuild Resource Cache`, `Delete` → `Confirm delete` + `Cancel`. Below the form, an
**Assigned Agents** card (only if the space has agents) lists them with columns `Display Name`, `ID`,
`Active` (yes/no), `Start Flow`, `Start Node`, and a `Link` (Visit → the agent).

---

## Ai → Agents

**List page** (`Agent List`). This list is **scoped to one space** — a `Space` picker sits in the
card header (`Select a space...`); until you pick one you see `Pick a space to see its agents.`
Columns: `Display Name`, `Agent ID` (shown as a mono badge), `Entry` (rendered `StartFlow-StartNode`),
`Status` (`Active` green / `Inactive` orange), and a `Link` (Visit). Empty state:
`No agents in this space yet.` The `Create Agent` button is on the Agents landing page.

**Create form** (card `Agent & Flow Binding`). Fields: `Space` (required select, `Select a space`),
`Display Name` (required, e.g. `Agent One`), `Agent ID` (required, e.g. `agent-one` — auto-fills as a
kebab-case slug from the display name until you edit it), `Start Flow` (placeholder `MainFlow`) and
`Start Node` (placeholder `Start`). Helper under the pair: PascalCase only; the run entry is shown as
`StartFlow-Start` (e.g. `MainFlow-Start`). Submit: `Create`.

**Detail page.** Above the form, a `Space Details` card with a `View Current Space` button. Main form
card `Identity & Run Entry`: a status badge (`Active`/`Inactive`), an `Active` switch, `Display Name`,
`Agent ID` (mono, with a `Copy Agent ID` icon), `Start Flow`, `Start Node`. Footer: `Save`,
`Rebuild Resource Cache`, `Delete` → `Confirm delete` + `Cancel`. Below the form, two cards linking to
the settings editors: **Agent Json Settings** (button `Json Settings`) and **Front Agent Settings**
(button `Front Settings`).

---

## Ai → Agents → Agent Settings (the JSONForm editor — reached from an agent, not a sidebar entry)

Reached from an agent's detail page — `Json Settings` (runtime fields your flow scripts read) and
`Front Settings` (partner-facing fields) open the **same editor**, just aimed at different data. Each
page also carries a `View Current Agent` card (button `View Current Agent`) and a cross-link to the
other settings surface.

**The editor.** In the card header, two badges: a validity badge (`valid` green / `invalid` red) and
a character counter reading `1,234 / 1,000,000 - allowed characters` (turns red over the limit). The body
is a table of fields with columns `Display Name`, `ID`, `Type`, `Required`, `Value`, `Actions`; empty,
it says `No fields yet — use Add Field to create one.`

- **`Add Field`** (the button reads `Add Field`) opens the **Add Field** modal: `Required` switch,
  `Display Name`, `Field ID` (auto kebab-case), and `Type` (select: `input`, `text`, `richtext`,
  `number`, `password`, `boolean`, `array`). Footer `Cancel` + `Add`.
- Each row has `Set Value` and `Edit Definition` buttons plus move/copy/remove icon buttons.
  `Set Value` opens a **Set Value** modal (`Cancel` + `Set`; array types get an `Add Item` button).
- **`Update Settings`** (the save button, with a check icon) sits in the footer next to `+ Add Field`;
  it's greyed until the form is valid, under the character limit, and changed. Writers only.

---

## Ai → Consumers

**List page** (`Consumer List`). Columns: `Name` (blank shows `—`), `Email`, `Contract` (badges
`Orphan` / `No tenant` when unbound), `Confirmed` (`Active` / `New`), `Created At`, and a `Link`
(Visit). Sortable headers plus an `Add Filter` / `Clear All` / `Apply` panel. Footer `Showing X–Y of
Z`. Empty states: `No consumers on this page.` / `No consumers match the filters.` The
`Create Consumer` button is on the Consumers landing page.

**Create form** (card `Consumer Details`). Fields: `Email` (required, placeholder `user@example.com`)
and `Contract` (a select; default option `No contract — belongs to the organization`). Submit:
`Create`.

**Detail page** (card `Tenant & Identity`). Badges: `Active`/`New`; `Partner sign-up` or `In-app`
(neither on a consumer an admin created — those rows carry no sign-up marker); and `Orphan` if its
tenant was deleted. Read-only `Email` and `Name`; a `Contract` select (moving a
consumer to another tenant trims its spaces and signs its session out — the form warns you first); a
read-only `Consumer ID` (copy icon `Copy Consumer ID`); and an `Activity` line. Footer (writers only):
`Save Contract` (or `Confirm unbind` when clearing the tenant, with `Keep current contract`),
`Reset Password` (confirmed consumers only), and `Delete` → `Confirm delete` + `Cancel`. Below the
form, a **Spaces** card: a board with columns `Space` and `Granted` — you can only grant spaces the
consumer's tenant offers — and a `Save Spaces` button. Without a tenant the board is locked
(`No tenant, no spaces`).

---

## Ai → MCP Consumers

The consumers an **AI agent** created for itself (`09-consumers.md`). The sidebar entry sits right
after Consumers and appears with the `mcp_consumers` **read** scope. **There is no `Create` card** —
an MCP account creates these, assigns their contract and spaces, and mints their token through the
Keen MCP server; the console never does. What the console *does* offer, to any holder of the
`mcp_consumers` **write** scope, are the three lifecycle controls: the **Enabled** switch (`Save`),
**Rotate Secret** and **Delete**.

**List page.** Columns: `Name`, `Contract` (or a `No contract` badge), `Enabled`, `Last login`,
`Created`, and a `Link` (Visit). Footer `Showing X–Y of Z`. Empty state: `No MCP consumers yet.`

**Detail page.** Badges `Enabled`/`Disabled` and `Last login …` (or `Never used`); then read-only
`MCP Consumer ID` (with a copy icon), `Name`, `Contract` (the tenant it belongs to), `Spaces` (the
subset of that contract's spaces it may use), `Created by` — the MCP account that made it — and a
`Timeline` (created / updated); plus an `Enabled` switch (off = the consumer can no longer obtain or
refresh a token). Name, contract and spaces are never editable here — only an MCP account changes
those, through the MCP server. Footer (`mcp_consumers` writers only): `Save` (the Enabled switch),
`Rotate Secret` (**a single click — no confirm**; it mints the new secret on the spot and shows a
**one-time secret panel** — the `MCP Consumer ID` and the new secret, each with a copy button, the
same reveal-once panel as MCP Accounts; the old secret stops working immediately; `I have copied it
— back to the consumer` returns to the form), and `Delete` → `Confirm delete` + `Cancel`.

---

## Api → Api Keys

One write scope unlocks this whole API section. An Api Key is the hub that binds four resources.

**List page** (`Api Key List`). Columns: `Name`, `Key Prefix`, `Origin` (`No webhook bound` when
unbound), `Bindings` (rendered `n of 4`), and a `Link` (Visit). Sortable headers. Empty state:
`No api keys yet.` The `Create Api Key` button is on the Api Keys landing page. (A cap on how many
keys you can create shows as an error alert on the create form, not a fixed message.)

**Create form** (card `Credential Details`). `Name` (required, placeholder `Enter Api Key Name`),
then four binding pickers in this order — `Pick a webhook`, `Pick a client`, `Pick a certificate`,
`Pick a consumer contract` (each optional; each has a `— No … —` "unlink" option). Submit: `Create`.
Afterward the form is replaced by a **reveal-once panel** headed `Api Key "<name>" created`: an alert
`Copy this key now — it will not be shown again`, the key in an `Api Key` field with a
`Copy api key` icon, and buttons `Open Api Key` / `Back to list`. **Copy the key here — it is never
shown again.**

**Detail page** (card `Bindings & Key Material`). `Api Key ID` (read-only, `Copy Api Key ID`), `Name`,
the four binding pickers again, and `Key Prefix` (read-only, mono). Next to the prefix is a `Rotate`
button (writers) → `Confirm rotate` + `Cancel`; rotating replaces the key and shows a fresh reveal-once
panel (`New key for "<name>"`, dismissed with `I have copied it — dismiss`). Footer: `Save`, then
**`Wake`** — enabled **only when all four bindings are set and the form is saved** (no unsaved
changes); hovering a disabled `Wake` tells you what's missing (e.g. "Bind a certificate before waking
this key." or "Save your changes before waking this key."). Also `Rebuild Resource Cache` and `Delete`
→ `Confirm delete` + `Cancel`.

**`Rebuild Resource Cache` on this page is a cascade**, unlike the same-named button elsewhere: it
rebuilds the served copy of everything bound to *this key* — the key, its certificate, client,
contract, the contract's policy, its spaces and their agents — and nothing else. It refuses with a
clear message if the key isn't fully configured (all four bindings). On success the toast reads
`Bound caches rebuilt — now Wake to push them to the partner` — click `Wake` next (`07-caches.md`,
`08-wake.md`).

---

## Api → Clients

**List page** (`Client List`). Columns: `Name`, `Client ID`, `Secret` (shows only a prefix + `…`),
`Api Key` (a badge, or `Unassigned`), and a `Link` (Visit). Empty state: `No API clients yet.` The
`Create Client` button is on the Clients landing page.

**Create form** (card `Client Identity`). One field: `Name` (required, placeholder
`Enter Client Name`). Submit: `Create`. Then a **reveal-once panel**: alert
`Client Secret — shown once`, the value in a `Client Secret` field with a `Copy client secret` icon,
and `I have copied it — open the client`. **Copy the secret here — it can't be shown again.**

**Detail page** (card `Name & Credentials`). Read-only `Api Key` panel (the key holding this client,
or `Unassigned`), a read-only `Secret` prefix, the editable `Name`, and `Client ID` (read-only,
`Copy Client ID`). Footer: `Save`, `Rebuild Resource Cache`, `Delete` → `Confirm delete` + `Cancel`.
Below the form, a **Rotate Secret** card (writers): a `Rotate Secret` button → `Confirm rotate` +
`Cancel`; on success it becomes the reveal-once secret panel again (dismiss with
`I have copied it — dismiss`).

---

## Api → Certificates

**List page** (`Certificate List`). Columns: `Name`, `ID`, `Folder ID`, `Secret Key` (badge `Set` /
`Unset`), `Bound API Key` (or `—`), `Created At`, and a `Link` (Visit). Empty state:
`No certificates yet.` The `Create Certificate` button is on the Certificates landing page.

**Create form** (card `Certificate Details`). `Name` (required, placeholder `Enter Certificate Name`)
and an optional `Secret Key` field with a **`Generate`** button (dice icon) beside it — the shared
symmetric secret both sides hold; leave it empty and the certificate has **no** secret key (the list
shows `Unset`). Submit: `Create`. **Nothing here is reveal-once** — the secret stays an editable
field.

**Detail page** (card `Key Material`). `Name`; `Secret Key` (with a `Copy secret key` icon and a
`Generate` button; leave empty to keep the current one); `Public Key` (a read-only PEM textarea with a
`Copy public key` icon — the private half never leaves the platform); a **Rotate Key Material** block
with a `Rotate` button → `Confirm rotate` + `Cancel`; read-only `Folder ID` (`Copy folder ID`) and
`Certificate ID` (`Copy certificate ID`). Footer: `Save`, `Rebuild Resource Cache`, `Delete` →
`Confirm delete` + `Cancel`.

---

## Api → Contracts (consumer contracts)

The biggest detail page — **three stacked cards**: identity, policy, and spaces.

**List page** (`Contract List`). Columns: `Name`, `Key`, `Spaces`, `Defaults` (`n in-app · n
partner`), `Registration` (`partner sign-up open` / `in-app only`), and a `Link` (Visit). Empty
state: `No consumer contracts yet.` The `Create Contract` button is on the Contracts landing page.

**Create form** (card `Tenant Details`). `Name` (required, placeholder `Enter Contract Name`) and an
optional `Key` (placeholder `Leave empty to have one minted`; if you type one it must be exactly
**19** letters/digits). Submit: `Create`.

**Detail — card `Identity & Key`.** Editable `Name`; the `Key` field (copy icon `Copy contract key`;
changing it signs the whole tenant out — a warning appears and `Save` escalates to a red
`Confirm key rotation` with a `Keep current key` option); read-only `Contract ID`
(`Copy contract ID`), `Bound API Key` (`Not bound to an API key yet` until bound from the Api Keys
section), and `Webhook`. Footer: `Save`, `Rebuild Resource Cache`, `Delete` → `Confirm delete` +
`Cancel`.

**Detail — card `Registration & Login Policy`** (the five toggles). A board with columns `Policy`,
`Currently`, `Enabled` and its own `Save Policy` button. The five rows:
- `Partner sign-up` — whether a partner site may register new consumers.
- `One-time code — consumers created in-app` — require an emailed code at login for in-app consumers.
- `One-time code — consumers who signed up on a partner site` — same, for partner-registered
  consumers.
- `Freeze partner-registered consumers` — refuse those consumers at login.
- `Freeze in-app-created consumers` — refuse in-app consumers at login.

**Detail — card `Spaces`** (the three assignment columns, one table). Columns: `Space`, `Assigned`
(the master set this tenant may offer at all), `In-app default` (auto-granted to consumers created
in-app), and `Partner default` (auto-granted to consumers who sign up on a partner site). The default
switches are disabled until `Assigned` is on. Its own `Save Spaces` button. Empty:
`No spaces exist yet — create one in AI Spaces before a tenant can offer anything.`

---

## Api → Webhooks

**List page** (`Webhook List`). Columns: `Name`, `Origin`, `Webhook`, `Api Key` (badge or
`Unassigned`), and a `Link` (Visit). Empty state: `No webhook targets yet.` The `Create Webhook`
button is on the Webhooks landing page.

**Create form** (card `Delivery Target`). `Name` (required, placeholder `Enter Webhook Name`),
`Origin` (required, placeholder `https://partner.example.com` — matched **exactly**, `scheme://host[:port]`,
no path, no trailing slash; the port matters), and `Webhook URL` (required, placeholder
`https://partner.example.com/api/keen-webhook`). Created **unassigned** — an api key claims it from
the key's own form. Submit: `Create`.

**Detail page** (card `Target & Binding`). A read-only `Api Key` binding panel (the key holding it, or
`Unassigned`), read-only `Webhook ID` (`Copy Webhook ID`), editable `Name`, `Origin`, and
`Webhook URL`. Footer: `Save`, `Rebuild Resource Cache`, `Delete` → `Confirm delete` + `Cancel`.
**Delete is refused while the webhook is bound** to an api key (`Webhook "…" is bound to an api key.
Unbind it there first.`) — clear it from the key's own form (`— No webhook —`), save, then delete.

---

## System → Cache

The **Cache Management** surface. You rarely touch it — the caches keep themselves current — but this is
where you can force a rebuild or clear one.

**Landing page** (`Cache Management`). Four resource cards — `Roles`, `Agents`, `Spaces`, `Api Keys`
— each with a one-line description and a single **`Manage`** button. No status readout here; that
lives on the per-resource page.

**Resource page** (opened by `Manage`, titled e.g. `Roles Cache`). Two cards plus a back button:
- **`Cache Actions`** — a **`Create`** button (builds a fresh cache from the live records and
  swaps it in atomically) and a red **`Invalidate`** button (clears the live cache until the next
  build). Both
  writers only. `Invalidate` is a **single click** — no two-step confirm; the red styling is the
  warning.
- **`Cache Status`** — read-only readouts: `State` (`Idle` / `Creating…` / `Invalidating…` /
  `Failed`), `Present` (`Yes` / `No`), `Last created`, `Entries`, `Size`, `Last changed by`,
  `Last changed at`, and a `Refresh Status` button. If a build failed, an alert reads
  `The last cache job failed`.
- **`View Caches`** button — back to the landing page.

**Note:** the same job also runs from a record's own detail page via the
**`Rebuild Resource Cache`** button in its footer (visible to anyone with the Cache write scope) — a
shortcut to rebuild just that resource without leaving the record. **Exception: on an Api Key** that
button is a *cascade* — it rebuilds every record bound to that key (and only those), not a whole
resource. See *Api → Api Keys* above.

---

## System → Logs

**Landing page** (`Log Management`). Three nav cards: **Channels** (button `Manage Channels`),
**Audit** (button `Browse Audit`) and **Log Records** (button `Manage Log Records`). The sidebar also
carries `Log Records` as its own entry under System.

**Channels page** (`Log Channels`, card `Channel Switchboard`). One row per channel, grouped into
System channels (`Action`, `Error`, `Warning`, `Debug`, `Info`) and Log channels (`Error`, `Warning`,
`Debug`, `Info`). Columns: `Channel`, `Group`, `Description`, `Status`. Each row's `Status` cell is an
on/off switch reading `On` / `Off` (writers only). `Action` and `Error` are **permanently on** — they
show a blue `Permanently engaged` badge and can't be toggled off. When the list is empty it says the
channels are seeded automatically on first run.

**Audit page** (`Log Audit`, card `Audit Browser`). Pick a channel from the **`Sink`** selector
(`Select a sink...`) — the five System sinks only: `System / Action`, `System / Error`,
`System / Warning`, `System / Debug`, `System / Info` (the Log channels have no static files here —
agent and script runtime lines live in the Log Records below). Until you pick one:
`Pick a sink to see its files.` A **Files** section then lists the dated files (newest first) with a
`Name` column and a per-file **`View`** button. `View` opens the **File** section, which shows the
**tail** of that file (the most recent lines). There's no separate "read" or line-count control — the
`Sink` selector and each file's `View` button are the only controls.

**Log Records page** (`Log Records`, card `Log Records`) — the dynamic per-space / per-agent logs.
A `Space` filter (`All spaces`) over a table with columns `Title`, `Scope` (the agent slug, or a
`Space-wide` badge), `Space`, `Status` (`Emitting` / `Paused`), `Client Read` (`Client-readable` /
`Private`), and `Actions` — an **Edit** link plus, for writers, a two-step `Delete` → `Confirm` +
`Cancel`. Empty state: `No log records yet — create one to start capturing a space or agent's runtime
logs.` The `Create Log Record` button lives on this page's create card (writers only).

- **Create form** (card `Log Scope`): `Title` (required), `Description`, a `Scope` radio —
  `Whole space` / `Single agent` — then `Space` and, for an agent log, `Agent` (`Pick a space first
  to choose an agent.`), and a `Client-readable` switch. Submit: `Create`.
- **Detail page** (card `Log Record`): an `Emitting` switch (pause / resume), `Title`,
  `Description`, `Space`, `Agent`, `Client-readable`, and a `Stream token` block — `Reveal stream
  token` shows the read credential a viewer needs for the live stream, with a `Copy` button. Footer:
  `Save` (greyed until changed) and `Delete` → `Confirm delete` + `Cancel`. The scope (space vs
  agent) is fixed at creation — changing it means a new record.

---

## Watch out for

- **A control you can't use isn't greyed — it's gone.** Missing buttons or whole sections almost
  always mean your role lacks that scope, not a broken page. An owner/admin grants it under
  **Organization → Roles**.
- **A greyed button means a precondition isn't met**, not a missing feature: `Save` needs an actual
  change; `Wake` needs all four bindings **and** a saved (unchanged) key; `Reset Password` shows only
  for a confirmed account; `Save Policy` / `Save Spaces` light up only when that board changed.
- **Delete is two-step, and so are most Rotates and key changes** — `Delete` → `Confirm delete`, an
  api key / client / certificate `Rotate` → `Confirm rotate`, a contract key edit →
  `Confirm key rotation`. **The one exception is the MCP account's `Rotate Secret` — a single click
  mints the new secret immediately.** Otherwise nothing destructive happens on the first click.
- **Cache `Invalidate` is also one click, no confirm.** The red styling is the only warning.
- **Reveal-once panels are your only chance.** The plaintext **api key** (on create and on rotate),
  the **client secret**, an **MCP account's secret** (on create and on `Rotate Secret`), and an
  **MCP consumer's secret** (on `Rotate Secret`) appear exactly once. Copy them the moment they
  show; lost means rotate, never recover. (Certificate secrets are *not* reveal-once — they stay
  editable.)
- **Some pages have fewer buttons on purpose.** *Ai → MCP Consumers* is view-only for every human
  **except** three lifecycle controls — the `Enabled` switch (`Save`), `Rotate Secret` and `Delete`
  (with `mcp_consumers` write); there is no `Create`, and name, contract and spaces stay read-only —
  the AI agent provisions those through the Keen MCP server. And an MCP account's `Name` is read-only
  after create (unique, permanent) — a wrong name means delete and re-create.
- **The `Create X` button lives on the section's landing page** (in the `Create X` card), not on the
  table — the table is reached via the `View X` button. Open a record from its row's **Visit** link.
- **Two agent naming rules don't mix:** the `Agent ID` slug is lowercase-with-dashes; `Start Flow` /
  `Start Node` are PascalCase. The form rejects the wrong format.
- **`Rebuild Resource Cache` (on a record's footer) and `Create` (on the Cache page) do the same
  kind of rebuild** — the first is a per-record shortcut, the second is the full Cache surface with
  status and `Invalidate`. **The one exception is the Api Key page**, where `Rebuild Resource Cache`
  is a cascade over everything bound to that key (and refuses a half-wired key) — follow it with
  `Wake`.
