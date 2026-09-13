# Wake — telling a partner site to refresh

**In one line:** Wake sends a "your configuration changed — re-read it" notice to a partner site,
so the site pulls fresh data without polling. It does **not** change anything itself.

## Why the button exists

A partner site holds a local copy of its KeenAgents configuration — its spaces, agents, contract,
policy, agent front settings, and the certificate it verifies tokens with. When an admin changes
any of that, the site needs to know to re-fetch. Polling would be wasteful and slow. So instead
KeenAgents **notifies** the site: it POSTs a small notice to the site's registered notification
URL, and the site re-fetches over its authenticated connection.

This is **notify-then-fetch**: the notice carries **no data** — it is only a hint to re-read. The
site never acts on the notice alone; it fetches the real, current values itself. That keeps the
site's copy correct even if a notice is delayed or missed, because the fetch is the source of truth.

## When it happens automatically — and when it doesn't

Some changes fire a notice on their own, without Wake:
- editing a contract's name / key / spaces / defaults / policy → the partner is notified to re-read
  its contract and policy;
- creating, editing or rotating the key's certificate, client, or the key itself → the partner is
  notified to re-read its key resources (a certificate change also carries the new material);
- deleting an API key → a final notice so the partner re-reads and discovers it's been revoked.

Changing a **space**, an **agent**, or an agent's **front settings** fires **no notice at all** —
those are exactly the changes Wake exists for (`07-caches.md`: two clicks on the key's page).

## When YOU press Wake (the manual button)

Wake lives on an **API key's detail page**. Use it to hand a partner everything at once — e.g. right
after you finish wiring a key, or after a behind-the-scenes change you want to push immediately.

### Steps

1. Open the API key's detail page (Api → Api Keys → the key).
2. Confirm the key is **fully bound** — Wake is only enabled when all four bindings (client,
   certificate, contract, webhook) are in place. If it's greyed out, finish the wiring first.
3. Make sure the form isn't dirty — save any pending edits first, so Wake pushes the saved record,
   not the half-edited one on screen.
4. Click **Wake**. A success toast names the URL it was delivered to.
5. On the partner side, the site receives the notice and re-fetches: its certificate material, its
   API-key/contract resources, its consumer policy, its spaces + agents, and its agent front
   settings — the full set.

## After you change anything bound to a key: one Rebuild, one Wake

Two clicks, both on the **same** page, always in this order:

1. Open the key (**Api → Api Keys → the key**). Make sure it's **fully bound** and **saved**.
2. Click **Rebuild Resource Cache**. On an api key this button is a **cascade**: it rebuilds the served
   copy of everything bound to that key — the key, its certificate, its client, its contract, the
   contract's policy, its spaces and the agents in them — and nothing else (`07-caches.md`). Wait for
   the toast: **"Bound caches rebuilt — now Wake to push them to the partner"**.
3. Click **Wake**. The partner re-fetches the freshly rebuilt set.

That's the whole routine after editing a contract's spaces or policy, an agent in one of the key's
spaces, its certificate, or its client — you no longer visit each record's page. **Rebuild first**
(so there is something new to fetch), **Wake second** (so the partner fetches it). Wake alone is
enough after a normal Save — the copy already refreshed itself — and it is the *only* thing that
tells the partner about a space or agent change; the cascade is for when you want to be certain
everything the partner reads is fresh at once.

## What Wake does NOT do

- It does **not** rebuild any server-side cache (the served copy is already fresh — see
  `07-caches.md`).
- It does **not** carry data — a partner that only reads the notice and doesn't re-fetch learns
  nothing.
- It is **delivered once, without retries** — by design. If the partner's endpoint is down, the
  notice is lost; the site will pick up changes on its next fetch or the next Wake.

## Watch out for

- **Wake is disabled until the key is fully bound** — this is the #1 "why is the button greyed
  out?" question. Bind client + certificate + contract + webhook.
- **Save before Wake** — waking a dirty form would push the saved values, not what's on screen.
- **A dead / paused partner endpoint** (e.g. a developer with a breakpoint on their webhook handler)
  makes Wake time out on their side — the admin action still succeeds; it's the partner that didn't
  answer. Harmless.
- **Rebuild before Wake, not after.** Waking first tells the partner to fetch a copy you're about to
  rebuild; it then needs a second Wake. Rebuild Resource Cache → Wake, in that order.
- **The key's Rebuild refuses a half-wired key** — it checks the four bindings **as saved** (unlike
  Wake, the button isn't greyed by an unsaved form — it simply refuses).
