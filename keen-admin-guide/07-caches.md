# Caches — the served configuration copy

**In one line:** KeenAgents keeps a ready-to-serve copy of your whole configuration so admin
pages and partner sites load instantly and always see current data. It refreshes itself; the
buttons exist for the rare time you want to force it.

## What is cached

One ready-to-serve copy per resource type — eight in all:

- `roles` (organization — accounts are not cached)
- `spaces`, `agents` (AI)
- `api_keys`, `clients`, `certificates`, `consumer_contracts`, `consumer_policy` (API access)

`consumer_policy` is deliberately **separate** from `consumer_contracts`: the contract copy holds
identity + the spaces it grants; the policy copy holds the live registration/login booleans +
default spaces. The consumer-auth path reads policy without pulling the whole contract.

Agent **settings blobs** (Json / Front settings, up to ~1 MB each) are *not* in these copies —
they have their own per-agent channel and are read on demand. Only the light agent record
(including a `hasSettings` flag) rides the agents copy.

## How it stays fresh (you don't manage this)

- **On every change.** Create / edit / delete / bind / unbind a space, agent, api key, client,
  certificate or contract → the affected resource copy is rebuilt immediately, and every reader
  (admin UI, partner sites) re-reads. There is **no refresh interval to wait out** — a save is
  visible on the next fetch. Two exceptions: the `roles` copy, and a **Webhook record's own
  fields** (name / origin / URL), are refreshed only by a Rebuild (or, for the webhook, by saving
  the api key that binds it).
- **On startup** — each reader primes its copy when it comes up.
- **After any interruption** — a reader re-reads everything when its connection recovers, and the
  partner-facing chat relay additionally re-reads on a ~30 s safety-net tick, so a copy can never
  drift from the truth for long.

So: **normal edits need no manual action.** If you just Saved something, don't reach for Rebuild.

## The manual controls (gated by the `cache` permission)

Both surfaces below need the **cache** scope: `cache` to see status, `cache:w` to act. Without
write, the buttons don't appear.

**A) The Cache page** — System → Cache (`Cache Management`). Four resource cards — `Roles`,
`Agents`, `Spaces`, `Api Keys` — each with a **Manage** button; the resource page then shows
present or not, entry count, size, when it was last built, who last changed it, and any job in
progress. The other four copies (`clients`, `certificates`, `consumer_contracts`,
`consumer_policy`) have no card here — they are rebuilt only from a record's own page (B below).
From a resource page you can:
- **Create** (rebuild) a resource — builds a fresh copy and swaps it in atomically (readers see
  wholly old or wholly new, never a half-built mix).
- **Invalidate** a resource — clears the copy; it rebuilds on the next change or Create. In the
  gap, a partner reading that resource gets an empty result — use deliberately.

**B) The Rebuild Resource Cache button** — on every record's detail page (Api Key, Client,
Certificate, Contract, Webhook, Space, Agent). On all of them **except the Api Key**, it is the same
job as Create on the Cache page, without leaving the record — it rebuilds that record's **whole
resource** (and for clients, certificates and contracts it is the only place to do so). Notes:
- A **Contract** rebuilds *both* `consumer_contracts` and `consumer_policy`.
- A **Webhook** rebuilds `api_keys` (the webhook's data lives on the API key it's bound to — there
  is no separate `webhooks` cache).

**C) The Api Key's Rebuild Resource Cache button is special — it's a cascade.** On an **Api Key's**
detail page, **Rebuild Resource Cache** rebuilds the copy of **every record bound to that key**, in
one click: the key itself, its **certificate**, its **client**, its **consumer contract**, that
contract's **consumer policy**, the contract's **spaces**, and the **agents** in those spaces. It
touches **only those records** — nothing else in any resource is rebuilt or wiped, so other partners'
records are left exactly as they were. It **refuses** (with a clear message) if the key is not fully
configured — all four bindings (client, certificate, contract, webhook) must be in place **as saved**
(a picker you changed but haven't saved doesn't count; the button itself is never greyed by an
unsaved form), because a half-wired key has nothing complete to rebuild for. On success the toast reads
**"Bound caches rebuilt — now Wake to push them to the partner"** — and that's the next click
(`08-wake.md`).

So after you change *anything* attached to a key — its contract's spaces or policy, an agent in one of
its spaces, its certificate or client — the whole refresh for that partner is **two clicks on the
key's page: Rebuild Resource Cache, then Wake.**

### How to rebuild a resource (the steps)

1. Make sure you have the **cache write** permission (`cache:w`) — otherwise the buttons are hidden.
2. Easiest: open the record's detail page and click **Rebuild Resource Cache**. Or go to
   System → **Cache**, click **Manage** on the resource card, and click **Create**.
3. Watch the `State` readout flip to *Creating…* → *Idle* with a fresh entry count and timestamp.
4. That's it — every reader has re-read the new copy.

### How to refresh everything a partner reads (the api-key cascade)

1. You need `cache:w` here too — the button is the same one, gated the same way.
2. Open **Api → Api Keys → the partner's key**. Confirm it's **fully bound** (all four pickers set)
   and **saved** — the cascade checks the stored bindings, not what's on screen, and refuses
   otherwise.
3. Click **Rebuild Resource Cache**. Wait for the toast **"Bound caches rebuilt — now Wake to push
   them to the partner"**.
4. Click **Wake**. The partner site re-fetches the freshly rebuilt set.

### What a record DELETE does to the cache

Deleting a record drops just that record's entry from the copy (surgical, not a whole rebuild).
Deleting a Client / Certificate / Contract also refreshes `api_keys` (it unbinds the key). Deleting
a Space also refreshes `agents` (its agents cascade away). You don't do anything — it's automatic.

## Why we do it this way

- **Instant reads** — partner sites and admin pages never wait on a live lookup.
- **Tenant isolation** — a partner's contract, policy, agent front settings and certificate are the
  ones bound to its own API key. (One exception today: the space list a partner fetches is the
  organization's **whole** list, every space with its agents — the partner keeps only the spaces its
  contract grants, `06-connect-a-partner-site.md`. What its consumers can actually *run* is still
  limited to the contract's spaces.)
- **Self-healing** — the copy converges back to the truth on its own; the buttons are a
  convenience, not a repair.
- **One key, one click** — a partner reads everything *through* its API key, so the key's own
  Rebuild follows the bindings out to every piece the partner will fetch (certificate, client,
  contract, policy, spaces, agents) and refreshes exactly those. You don't have to remember which of
  seven pages to visit, and you never rebuild a whole resource — other partners' records are not
  disturbed.

## Wake is NOT a cache rebuild

Pressing **Wake** on an API key does *not* rebuild any cache. Wake sends a notice to the partner
site telling it to re-read; the site then fetches from the already-fresh copy. Cache freshness and
Wake are two separate things — see `08-wake.md`.

## Watch out for

- **Don't Rebuild after a normal Save** — it's redundant; the copy already refreshed. (Redundant,
  not harmful: the README's "one Rebuild, one Wake" after a change is the always-safe routine.) The
  exception is a **Webhook** edit — its new Origin / URL reach the copy only through a Rebuild on its
  key (or on the webhook's own page).
- **Invalidate leaves a gap** — nothing is served for that resource until it rebuilds. Prefer
  Rebuild (atomic swap) unless you specifically want it empty.
- **The buttons are permission-gated** — if a teammate says "I don't see a Rebuild button," they're
  missing the `cache` write grant, not looking in the wrong place.
- **The Api Key's Rebuild is the cascade; the other pages' Rebuilds are not.** Pressing Rebuild on
  a Space or an Agent rebuilds that one resource for everyone; pressing it on an **Api Key** rebuilds
  everything bound to *that key* and nothing else. Reach for the key when the goal is "refresh this
  partner."
- **The cascade refuses a half-wired key.** If it says the key isn't fully configured, bind the
  missing client / certificate / contract / webhook first, Save, then Rebuild again.
- **Rebuild, *then* Wake.** The cascade refreshes the served copy; it does not tell the partner. The
  toast reminds you — click **Wake** next (`08-wake.md`).
