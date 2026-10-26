# Pages

The page inventory, split by area. For each: what it does, which guard gates it,
and the flow it drives. Verified against `src/app`.

The `proxy.ts` gate (see [`architecture.md`](architecture.md)) enforces: app pages
redirect a signed‑out user to `/login`; both areas send the user to `/maintenance`
while the Keen connector isn't ready. Guest pages do **not** bounce a signed‑in
user (the redirect‑to‑`/` branch in `proxy-page-auth.ts` is unreachable), so a
live session can still open `/login` or `/registration`.

---

## Guest pages (`(login)` + `(registration)`)

### `/login` — sign in (+ OTP)
`src/app/(login)/login/`

Two forms share one page and toggle via local state:

- **LoginForm** posts credentials to `/api/login`. Three outcomes:
  - **success** → session cookies are set server‑side; `router.replace('/')` +
    `router.refresh()` so the proxy admits the session.
  - **otp** → Keen returned a "Verify" challenge; the page swaps to the OTP form
    (the pending hash is mirrored to `localStorage` so a reload resumes it, with a
    TTL countdown).
  - **rejected / server‑error** → an inline root error.
- **OtpForm** posts the 6‑digit code to `/api/otp`; success finishes login the
  same way.

The page also reads one‑time `?reset=success` / `?registration=success` flags (set
by the redeem redirects), shows the matching message, then strips the param.

### `/registration` — create an account (claim leg)
`src/app/(registration)/registration/`

A full profile form (email, password + confirm, gender, first/last name, DOB,
consent). On submit it POSTs to `/api/registration`, which is the **claim** leg:
**nothing is created yet** — Keen emails a verification link and the form swaps to
"check your inbox". The account exists only after the link is followed (below).
Registration (like the reset / password‑change / profile‑update legs) requires the
tenant's contract policy `outsideRegistration` to be on; otherwise the Keen edge
answers 403 "Action forbidden.", the form shows it as its root error, and no mail
is sent.

### `/confirmation/[hash]` — finish registration (redeem leg)
`src/app/(registration)/confirmation/[hash]/page.tsx`

A **server component**. The link Keen emailed lands here; it opens the sealed hash
through the connector (server‑side, holding the tenant secret), redeems it — Keen
creates the account from the details baked in at claim time — and redirects to
`/login?registration=success`. A bad/expired hash renders a neutral
invalid/expired panel. (Redeems on GET, so an email client that prefetches the
link would consume the single‑use grant early.)

### `/reset-password` — forgot password (claim leg)
`src/app/(login)/reset-password/`

Email + new password + confirm. POSTs to `/api/reset-password` (the claim leg);
Keen emails a link; the form swaps to "check your inbox". The password is
**unchanged** until the link is followed.

### `/set-password/[hash]` — apply the new password (redeem leg)
`src/app/(login)/set-password/[hash]/page.tsx`

A **server component**, mirror of `/confirmation/[hash]`: opens the sealed hash,
redeems it (Keen applies the password argon‑hashed in at claim time), redirects to
`/login?reset=success`, or shows the invalid/expired panel.

---

## App pages (`(app)` — authenticated)

### `/` — your spaces
`src/app/(app)/page.tsx` → `content.tsx`

Server page; the client half reads `useConsumer().consumerSpaces` and renders a
card per space, each linking to `/space/[id]`.

### `/space/[id]` — agents in a space
`src/app/(app)/space/[id]/`

Client content finds the space in `consumer.consumerSpaces`, lists its **active**
agents, each linking to `/space/[id]/[agentID]`. An unknown/forbidden space id
renders a plain "no access" message.

### `/space/[id]/[agentID]` — the consumer's chats (under an agent)
`src/app/(app)/space/[id]/[agentID]/`

The server page fetches the consumer's chat list (`keen.consumer.getChatList`) and
hands it down. That list is **not scoped to this agent** — it is every chat the
consumer owns (each `ChatListItem` carries its `agentId`, but the page doesn't
filter on it), so **Continue** opens `/space/[id]/[agentID]/[chatID]` for any of
them: the history loads by `chatId`, and new turns go to *this* agent. The client
half:

- **Start new conversation** mints a fresh `chatID` (a UUID) and navigates to
  `/space/[id]/[agentID]/[chatID]`.
- Lists existing chats with **Continue** (open the thread), inline **rename**
  (double‑click → `chat.setTitle`), and **Delete** (`chat.delete`, an optimistic
  removal from the list — on Keen a **soft archive**: `archived = true`, never a
  hard delete, no erase mode). Chat management goes through
  `useConsumer().chat.*` → `/api/chat/*`.

### `/space/[id]/[agentID]/[chatID]` — THE chat
`src/app/(app)/space/[id]/[agentID]/[chatID]/`

The chat itself. The server page reads `consumerData` and passes it to the client
`Content`, which resolves the agent's **slug** (`agentId`) from the row id and
mounts the chat UI:

```tsx
<ChatShell chatID={chatID} agentID={agentID} spaceID={spaceID} consumerData={consumerData}>
  <ChatMessages />
  <ChatPrompt />
</ChatShell>
```

- **ChatShell** owns the `ChatAPI` lifecycle + the conversation (see
  [`chat-sdk.md`](chat-sdk.md)).
- **ChatMessages** shows persisted history (last 50, fetched once via
  `/api/chat/history`) then this session's live turns; it renders `<SYSTEM CALL>`
  fences an agent writes as tool‑call chips.
- **ChatPrompt** is the input; **Send** is gated on `connected && !running`
  (one turn at a time), with a **Cancel** button that appears only mid‑run.

This is where your flow actually runs. `runFlow({ chatId, prompt })` sends the
turn; the answer streams into a bubble. See [`callbacks.md`](callbacks.md) and
[`errors.md`](errors.md) for what the user sees on success, cancel, and failure.

### `/user` — account (profile + password)
`src/app/(app)/user/`

The server page prefills the form straight through the connector
(`keen.consumer.getProfile` — the same read `/api/consumer/profile` exposes to the
client). Two forms:

- **ProfileForm** — edit first/last name, gender, DOB. Saves via
  `/api/consumer/update` as a **partial** update (a blank field is left unchanged,
  not wiped); email is the identity and is read‑only. On success it patches the
  auth context optimistically so the header name updates at once — but Keen's
  update reply carries no new token, so the session cookie is **not** re‑minted
  and the next server render (a navigation or `router.refresh()`) re‑seeds the
  header from the old token until the consumer logs in again.
- **PasswordForm** — a logged‑in password change is a two‑leg flow: this posts the
  new password to `/api/consumer/reset-password` (the **claim**), and Keen emails a
  confirm link. So success here means "check your email", never "changed". The
  current password isn't asked — the live session is the proof of identity. Like
  every self‑service leg it needs the contract's `outsideRegistration` flag on;
  off → 403 "Action forbidden." as the root error.

### `/confirm-password/[hash]` — confirm a logged‑in password change (redeem leg)
`src/app/(app)/confirm-password/[hash]/page.tsx`

A **server component** in the authenticated area (a signed‑out visitor is bounced
to `/login` first — the redeem needs the live session). It opens the sealed hash
and redeems through the connector (two‑token: the session cookie + the app token),
then shows "your password has been changed" or the invalid/expired panel.

---

## Utility pages

- **`/maintenance`** (`(maintanance)`, sic — the folder's spelling) — shown by the
  proxy while the Keen connector isn't ready: at boot until the certificate arrives,
  after an `r_cert_delete`, and briefly during every WAKE (see
  [`architecture.md`](architecture.md) §5).
- **catch‑all 404** (`(not-found)/[...not_found]`) — any unmatched URL. Note it
  resolves as a real route match, so it responds HTTP 200 (a "soft" 404).
