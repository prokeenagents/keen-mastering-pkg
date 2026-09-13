# API access — the chain a partner site needs

**In one line:** a partner talks to your agents through an **Api Key** that binds four sibling
resources — a **Client**, a **Certificate**, a **Consumer Contract**, and a **Webhook**. Only when
all four are bound is the key **fully bound** and usable.

Everything here lives in the sidebar's **Api** group, as five entries: **Api Keys**, **Clients**,
**Certificates**, **Contracts**, **Webhooks**. Each entry has its **own** permission scope —
`api_keys`, `clients`, `certificates`, `contracts`, `webhooks` — read to see it, write to act on it.
A role that should wire a partner end to end needs **all five** (with Write); granting only
`api_keys` leaves the other four entries invisible.

## The pieces (what each one is)

| Resource | What it is |
|---|---|
| **Api Key** | The hub + one of the partner's three secrets. The plaintext key (`kak_…`) is presented together with the client id + secret when the partner server exchanges credentials for an application token — it is never sent on its own as a Bearer credential. Stored only as an irreversible hash; lists show a `kak_` + 8-char display prefix. |
| **Client** | The partner server's OAuth-style identity — a `kcid_…` client id + a reveal-once secret. This is what the server exchanges for an application token. |
| **Certificate** | The tenant's signing material (an RSA keypair + a shared secret). Its public half + secret are delivered to the partner; the private key never leaves KeenAgents. |
| **Consumer Contract** | The per-tenant policy + the set of spaces this tenant may use. Carries a 19-char `key` that stamps every consumer as belonging to this tenant. |
| **Webhook** | A named pairing of the partner's browser **Origin** and a **notification URL**. Because origins are unique, an inbound request's Origin always resolves to exactly one key. |

"**Fully bound**" = all four bound. Only then does the key's Origin join the allow-list, tokens can
be minted, and Wake is enabled. Unbinding any one switches the partner off the same way.

## How to open API access for a partner (the steps)

Do them in **this** order — it's the canonical one (steps 3–8 of the README's Golden path), and
each step's pickers need what the earlier steps made. The space and its agent already exist (Golden
path steps 1–2, `03-spaces-and-agents.md`). Keep a note of every ID and secret; never write a real
secret anywhere but the partner's own config.

1. **Create the Certificate.** Api → Certificates → **Create**. Fill **Name**; the **Secret Key**
   field is optional — type one (16–32 characters) or press **Generate**. Press **Create**. The
   public PEM is always viewable on the detail page. Remember its **ID**.
2. **Create the Client.** Api → Clients → **Create**. Fill **Name**, press **Create**. A panel titled
   **Client Secret — shown once** appears with the **secret** and a copy button — it is
   **reveal-once**; copy it now and hand it to the partner's server team. Then press **I have copied
   it — open the client**: the **client id** (`kcid_…`) is on the detail page, with its own copy
   button. Remember the **ID + secret**.
3. **Create the Consumer Contract.** Api → Contracts → **Create**. Fill **Name** (leave **Key**
   empty to have one minted), press **Create**. Remember its **ID**. Then on its detail page (this
   is the Golden path's **5.1**): in the **Spaces** card, tick **Assigned** for the space you made
   (that's what this tenant may use), and tick **In-app default** / **Partner default** if new
   consumers should get it automatically; **Save**. In the **Registration & Login Policy** card set
   the five Yes/No rows — **Partner sign-up**, **One-time code — consumers created in-app**,
   **One-time code — consumers who signed up on a partner site**, **Freeze partner-registered
   consumers**, **Freeze in-app-created consumers**; **Save**. These are the outside-consumer
   settings.
4. **Get the partner's Origin.** For the reference partner site this is a tunnel: start
   `ngrok http 3000` and take the URL it prints (`https://<your-tunnel>.ngrok-free.app` — a
   placeholder). A real partner tells you its site's Origin instead.
5. **Create the Webhook entry.** Api → Webhooks → **Create**. Three fields: **Name**; **Origin** —
   the partner's exact browser origin (`scheme://host[:port]` — the port matters; only 80/443 are
   omitted; no path, no trailing slash, no wildcards; for the tunnel: the ngrok URL); and **Webhook
   URL** — the partner's notification URL (for the reference site: `<ngrok URL>/api/keen-webhook`).
   Press **Create**. Remember the **Webhook ID**.
6. **Create the Api Key and bind all four.** Api → Api Keys → **Create**. Give it a **Name**, then use
   the four pickers — **Pick a webhook**, **Pick a client**, **Pick a certificate**, **Pick a
   consumer contract** (in that order on the form) — to bind **every** resource you just made (the
   Golden path's **8.1**). Press **Create**. The plaintext key is shown **once** in a reveal panel
   (*"Copy this key now — it will not be shown again"*) — copy it, then **Open Api Key** to reach the
   detail page, where the **Api Key ID** has a copy button. Remember the key's **ID + secret**.
7. **Confirm it's fully bound.** On the key's detail page all four bindings should be set. Now the
   Origin is allow-listed and Wake is enabled.
8. **Hand off, Rebuild, Wake.** Give the partner: the **Client id + secret**, the **Api Key id +
   secret**, and confirm the **Origin** + **notification URL** (for the reference site these go into
   its `.env.local` — `06-connect-a-partner-site.md`). Then, on the key's page: **Rebuild Resource
   Cache** (on an api key it's a cascade — it rebuilds everything bound to the key; `07-caches.md`),
   and **Wake** to push the initial configuration (`08-wake.md`). The partner site takes it from here
   → `06-connect-a-partner-site.md`.

## Rotation & deletion (what cuts access)

- **Rotate the Api Key** — mints a new plaintext, keeps the record's identity. Cuts off *direct
  raw-key* calls immediately, but **does NOT revoke application tokens** (they ride the key's
  identity, which rotation preserves).
- **Rotate a Client secret** — a new secret is shown once; the old one stops working the moment you
  confirm.
- **Rotate a Certificate** — re-mints the RSA keypair in place: the old public key stops verifying
  immediately and the new public PEM is (as always) readable on the detail page. The **shared secret
  key is not touched** by a rotate — it stays as it was, readable and editable on the same page (it's
  the one credential here that is never reveal-once).
- **Delete the Api Key** — revokes everything, including outstanding application tokens, and sends
  the partner a final notice so it discovers the revocation.
- **Delete a bound Client / Certificate / Contract** — *unbinds* it from the key (the key survives
  as a partial row) and the key stops being fully bound → the partner loses access until re-bound.
- **Delete a bound Webhook** — refused: *"Webhook "…" is bound to an api key. Unbind it there
  first."* Clear the **Pick a webhook** field on the key and Save, then delete the webhook.

To truly revoke a partner: **delete the key**, or unbind its certificate or contract. Not rotation.

## Watch out for

- **A half-wired key is invisible to the partner** but fully visible in the admin list (on purpose —
  it's the only place to finish partial wiring). The partner gets **no explanation**: its Origin is
  not allow-listed until all four bindings are in place, so every call is **silently dropped** (a
  connection reset / generic gateway 502 — exactly like a wrong Origin); and even when the origin
  does pass, the token request answers a uniform **HTTP 500 "Invalid request"** with no reason. The
  reason is visible **only to the admin** — open the key and look at which of the four pickers is
  empty. That's an operator wiring task, not a partner outage.
- **Origin is exact** — a mismatch (wrong scheme, host, or port) is **silently dropped**: the caller
  sees a connection reset / generic gateway error, never a descriptive one. If a partner "can't
  connect at all," check the Origin on its Webhook entry first.
- **Reveal-once is absolute** — the plaintext key and the client secret appear once. Lost = rotate and
  re-hand; there is no recovery.
- **Org-wide caps** — 20 api keys (and similar per-resource caps); create fails past the cap with a
  "Reached the maximum number of…" message. Delete one first.
- **Order matters, and the key comes last.** Certificate → Client → Contract (+ its spaces and
  policy) → Webhook → Api Key, then bind all four on the key. Doing the key first leaves its pickers
  empty; doing the webhook before you know the partner's real Origin means editing it later.
- **After the key is bound: Rebuild, then Wake** — not Wake alone. The key's Rebuild Resource Cache
  refreshes everything bound to it and refuses a half-wired key.
