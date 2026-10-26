# Pages

The page inventory, split by area. For each: what it does, which guard gates it,
and the flow it drives. Verified against `src/app`.

The `proxy.ts` gate (see [`architecture.md`](architecture.md)) enforces: a
signed‑out user asking for anything but a guest page is redirected to `/login`;
both areas hold a request up to 10 s while the Keen connector boots, then send it
to `/maintenance` if it still isn't ready. Guest pages do **not** bounce a
signed‑in user (the redirect‑to‑`/` branch in `proxy-page-auth.ts` is
unreachable), so a live session can still open `/login` or `/registration`.

Every page renders through the brand theme (`src/theme/brand.config.ts`, see
[`README.md`](README.md)): the guest pages sit on a centred card over an animated
backdrop; the app pages sit inside the app shell.

---

## Guest pages (`(login)` + `(registration)`)

Each guest page first calls `checkPageAvailability()`: while the connector is not
ready or no consumer contract is loaded, the form pages show a "We're a little
busy" card with a **Try again** button instead of the form, and the two link
landings (`/confirmation/[hash]`, `/set-password/[hash]`) show "This link can't be
used — We are a little busy at the moment" without redeeming.

### `/login` — sign in (+ OTP)
`src/app/(login)/login/`

Two forms share one page and toggle via local state:

- **LoginForm** posts credentials to `/api/login`. Three outcomes:
  - **success** → session cookies are set server‑side; `router.replace('/')` +
    `router.refresh()` so the proxy admits the session.
  - **otp** → Keen returned a "Verify" challenge; the page swaps to the OTP form
    (the pending hash is mirrored to `localStorage` so a reload resumes it, with a
    TTL countdown).
  - **rejected / server‑error** → an inline root error — Keen's message when it is
    a short plain sentence, else "Sign-in failed. Check your email and password."
- **OtpForm** posts the 6‑digit code to `/api/otp`; success finishes login the
  same way.

Login only checks that a password is present, never its strength, so an account
made under an older password rule can still sign in. The page also reads one‑time
`?reset=success` / `?registration=success` flags (set by the redeem redirects),
shows the matching message, then strips the param.

### `/registration` — create an account (claim leg)
`src/app/(registration)/registration/`

A full profile form (email, password + confirm, gender, first/last name, DOB,
consent). The password must have 8+ characters with an upper‑case letter, a
lower‑case letter and a digit (the hint under the field; the route enforces the
same rule). On submit it POSTs to `/api/registration`, which is the **claim** leg:
**nothing is created yet** — Keen emails a verification link and the form swaps to
"check your inbox". The account exists only after the link is followed (below).
Registration (like the reset / password‑change / profile‑update legs) requires the
tenant's contract policy `outsideRegistration` to be on; otherwise the Keen edge
answers 403 "Action forbidden.", the form shows it as its root error, and no mail
is sent. A claim Keen refuses as an existing account comes back as 409 "An account
with this email address already exists. Sign in, or use “Forgot password?”…".

### `/confirmation/[hash]` — finish registration (redeem leg)
`src/app/(registration)/confirmation/[hash]/page.tsx`

A **server component**. The link Keen emailed lands here; it opens the sealed hash
through the connector (server‑side, holding the tenant secret), redeems it — Keen
creates the account from the details baked in at claim time — and redirects to
`/login?registration=success`. Keen only notices an existing account at this
step (the create hits the email + contract unique key), so that refusal renders
**"You already have an account"** with a pointer to sign in or "Forgot password?"
rather than calling the link invalid. Any other failure, or a bad/expired hash,
renders the neutral invalid/expired panel. (Redeems on GET, so an email client
that prefetches the link would consume the single‑use grant early.)

### `/reset-password` — forgot password (claim leg)
`src/app/(login)/reset-password/`

Email + new password + confirm (the same password rule). POSTs to
`/api/reset-password` (the claim leg); Keen emails a link; the form swaps to
"check your inbox". The password is **unchanged** until the link is followed.

### `/set-password/[hash]` — apply the new password (redeem leg)
`src/app/(login)/set-password/[hash]/page.tsx`

A **server component**, mirror of `/confirmation/[hash]`: opens the sealed hash,
redeems it (Keen applies the password argon‑hashed in at claim time), redirects to
`/login?reset=success`, or shows the invalid/expired panel.

---

## App pages (`(app)` — authenticated)

Every app page renders inside the **app shell** (`components/ui/app-shell/`): on a
desktop a collapsible sidebar, on a phone a top bar with the same sidebar in a
drawer. The sidebar carries **New chat** (a dialog listing every available agent
by space, with a filter), the consumer's conversations with a search box (by title
or agent name), and the user menu (account, colour mode, sign out). The
conversation list is the shared `ChatListProvider`, seeded server‑side by the
layout (`keen.consumer.getChatList`), so a rename or delete shows up everywhere at
once.

### `/` — home
`src/app/(app)/page.tsx` → `content.tsx`

A greeting, the most recent conversations ("pick up where you left off"), and a
card per space from `useConsumer().consumerSpaces` (with its agents and chat
count), each linking to `/space/[id]`.

### `/space/[id]` — agents in a space
`src/app/(app)/space/[id]/`

Client content finds the space in `consumer.consumerSpaces` and lists **all** its
agents, active first: each card offers **New chat** and its conversations
(`/space/[id]/[agentID]`). A disabled agent stays visible but both buttons are
off. An unknown or forbidden space id renders "Space not found".

### `/space/[id]/[agentID]` — the consumer's chats with this agent
`src/app/(app)/space/[id]/[agentID]/`

The server page passes only the route params; the client half reads the shared
conversation list and shows **only this agent's chats** (each `ChatListItem`
carries the agent's slug, resolved to the agent row), newest first, with a
search by title:

- **Start a conversation** / **New chat** mints a fresh `chatID` (a UUID) and
  navigates to `/space/[id]/[agentID]/[chatID]`.
- Each row opens the thread; its **···** menu renames it inline
  (`chat.setTitle`) or deletes it after a confirmation dialog (`chat.delete` — the
  row leaves the list once the server confirms; on Keen a **soft archive**:
  `archived = true`, never a hard delete, no erase mode). Chat management goes
  through `useChatList()` → `useConsumer().chat.*` → `/api/chat/*`.

### `/space/[id]/[agentID]/[chatID]` — THE chat
`src/app/(app)/space/[id]/[agentID]/[chatID]/`

The chat itself. The server page reads `consumerData` and passes it to the client
`Content`, which checks the agent is active and in one of the consumer's spaces
(else "This conversation isn't available"), resolves the agent's **slug**
(`agentId`) from the row id and mounts the chat UI:

```tsx
<ChatShell chatID={chatID} agentID={agentID} spaceID={spaceID} consumerData={consumerData}>
  <ChatHeader space={space} agent={agent} showSteps={showSteps} onToggleSteps={…} />
  <ChatMessages agentName={…} spaceTitle={…} showSteps={showSteps} />
  <ChatPrompt agentName={…} />
</ChatShell>
```

- **ChatShell** owns the `ChatAPI` lifecycle + the conversation (see
  [`chat-sdk.md`](chat-sdk.md)).
- **ChatHeader** shows the agent and the connection, renames (double‑click the
  title) or deletes the chat, and toggles **Steps** — whether each turn's run
  trace starts expanded (remembered per browser).
- **ChatMessages** shows persisted history (last 50 turns, fetched once via
  `/api/chat/history`) then this session's live rows, folded into **turns**
  (`chat-messages/turns.ts`): per prompt, the agent's steps — engine events
  (`thinking` / `processing` / `progress`), tool calls parsed out of the
  `<SYSTEM CALL>` fences an agent writes, and any prose before the last tool call —
  go into a collapsible run trace ("worked for 4s · 3 steps"), open while the turn
  runs; the prose after the last tool call is **the answer**, rendered as markdown
  (raw HTML off). Code in an answer always renders as a highlighted code block:
  fenced code as‑is, and code an agent sent without a fence (JSON, HTML, a few lines
  of JS…) is fenced first (`chat-messages/code-fence.ts`). A finished answer gets
  **Copy** and **Ask again**. An empty conversation offers the brand's starter
  prompts.
- **ChatPrompt** is the input (Enter sends, Shift+Enter is a newline); **Send** is
  gated on `connected && !running` (one turn at a time) and turns into **Stop**
  mid‑run. Next to it, the **dictation** button records speech into the box (see
  [`README.md`](README.md), *Dictation*).

When a turn settles the page re‑reads the conversation list, so a brand‑new chat
appears in the sidebar with its title.

This is where your flow actually runs. `runFlow({ chatId, prompt })` sends the
turn; the answer streams into the turn's answer. See [`callbacks.md`](callbacks.md)
and [`errors.md`](errors.md) for what the user sees on success, cancel, and
failure.

### `/user` — account (profile + password)
`src/app/(app)/user/`

The server page prefills the form straight through the connector
(`keen.consumer.getProfile` — the same read `/api/consumer/profile` exposes to the
client). Two forms:

- **ProfileForm** — edit first/last name, gender, DOB. Saves via
  `/api/consumer/update` as a **partial** update (a blank field is left unchanged,
  not wiped); email is the identity and is read‑only. On success it patches the
  auth context optimistically so the name in the user menu updates at once — but
  Keen's update reply carries no new token, so the session cookie is **not**
  re‑minted and the next server render (a navigation or `router.refresh()`)
  re‑seeds the name from the old token until the consumer logs in again.
- **PasswordForm** — a logged‑in password change is a two‑leg flow: this posts the
  new password (the same password rule) to `/api/consumer/reset-password` (the
  **claim**), and Keen emails a confirm link. So success here means "check your
  email", never "changed". The current password isn't asked — the live session is
  the proof of identity. Like every self‑service leg it needs the contract's
  `outsideRegistration` flag on; off → 403 "Action forbidden." as the root error.

### `/confirm-password/[hash]` — confirm a logged‑in password change (redeem leg)
`src/app/(app)/confirm-password/[hash]/page.tsx`

A **server component** in the authenticated area (a signed‑out visitor is bounced
to `/login` first — the redeem needs the live session). It opens the sealed hash
and redeems through the connector (two‑token: the session cookie + the app token),
then shows "Password changed" or the invalid/expired panel, each with a link back
to the account page.

---

## Utility pages

- **`/maintenance`** (`(maintanance)`, sic — the folder's spelling) — "We'll be
  right back", with **Try again**. The proxy sends a request here when the Keen
  connector still isn't ready after the 10 s cold‑start hold: at boot until the
  certificate arrives and the first reads finish, after an `r_cert_delete`, after
  an `r_consumer_policy_delete` (see [`architecture.md`](architecture.md) §5). A
  WAKE no longer sends anyone here. Once the connector is ready, `/maintenance`
  redirects to `/`.
- **404** (`src/app/global-not-found.tsx`, enabled by `experimental.globalNotFound`
  in `next.config.ts`) — a real HTTP 404 for a URL no route matches. Only a
  signed‑in visitor reaches it; a signed‑out one is redirected to `/login` by the
  proxy first. A path that does match a route but names nothing (`/space/<unknown>`)
  renders that page's own "not found" state with 200.
