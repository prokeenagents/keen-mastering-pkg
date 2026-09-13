# Cookies → script nodes

A flow's **script nodes** can read request‑scoped cookies the consumer carried in
(for example a "Google Connect" token cookie). This is how a browser cookie reaches
your flow — and how a headless caller can supply the same value without a browser.

Relevant files: `src/service/services/chat/index.ts` (the `cookies` option),
`utils.ts` (`readBrowserCookies` / `resolveRequestCookies`), `task-queue.ts` (the
`requestContext` block), and the `ChatAPIOptions.cookies` type in
`src/@types/chat.d.ts`.

---

## The `cookies` option — two shapes

You configure cookies once, on the `ChatAPI` constructor:

```ts
cookies?: string[] | Record<string, string>;
```

### Shape 1 — a list of NAMES (a browser allow‑list)

```ts
new ChatAPI({ …, cookies: ['gconnect', 'locale'] });
```

Read from the **browser's `document.cookie`**, forwarding only the named cookies.
Two edge behaviours:

- **omit the option** → forward *every* JS‑readable cookie (the default).
- **`cookies: []`** → forward **nothing**.
- **`HttpOnly` cookies are never visible to `document.cookie`**, so they are never
  in this list — you cannot forward an HttpOnly cookie this way.

```ts
// utils.ts — readBrowserCookies(allow)
const filter = allow ? new Set(allow) : null;   // undefined → all; []/[names] → filtered
// …iterate document.cookie, keep names in `filter` (or all if none)…
```

### Shape 2 — an explicit `{ name: value }` MAP

```ts
new ChatAPI({ …, cookies: { gconnect: '<token>' } });
```

Used **as‑is, no browser needed**. This is how a **headless caller** (a
flow‑building agent running the SDK via the CLI) supplies a cookie a real user's
browser would otherwise carry — you provide the value directly.

```ts
// utils.ts — resolveRequestCookies(config)
if (config && !Array.isArray(config)) return { ...config };  // explicit map, used verbatim
return readBrowserCookies(config);                            // else names/undefined → browser
```

In entanglement the shell passes **no** `cookies` option, so it forwards every
JS‑readable browser cookie by default.

---

## The path to a script node

Cookies are forwarded **only on the INITIAL run**, inside `requestContext.cookies`.
`TaskQueue.run` builds that block from the resolved config:

```ts
// task-queue.ts — initial run payload
requestContext: {
  cookies: resolveRequestCookies(this.chat.cookieConfig)
}
```

The chain, end to end:

```
ChatAPI({ cookies })                       // names[] or { name: value }
   │  resolveRequestCookies(...)           // map used as-is, or read document.cookie
   ▼
InitialRunPayload.requestContext.cookies   // { name: value }, sent on the FIRST run only
   ▼
stored server-side for THIS run            // scoped to the run, dies with it
   ▼
a script node reads a value:
   import Cookies from 'system/cookies';
   const token = Cookies.get('gconnect');
```

Key properties to keep in mind when authoring a flow that reads a cookie:

- **Initial run only.** The map rides the first frame of a turn; continuations don't
  re‑send it. The Keen server stores it for the run and a script node reads it back.
- **Run‑scoped and short‑lived.** The stored cookies belong to that one run and are
  cleared when it ends — they are not durable state.
- **Read‑only for scripts.** A script node reads a cookie via `system/cookies`
  (`Cookies.get(name)`); it can't set one on the browser.
- **HttpOnly never travels** (shape 1 can't see it; shape 2 only carries what you
  explicitly put in the map).

---

## Practical notes for a building agent

- **Testing a cookie‑reading flow from the CLI:** use the **explicit map** shape so
  you don't need a browser — `cookies: { gconnect: 'test-token' }` — and read it in
  the script node with `Cookies.get('gconnect')`.
- **In the real browser app:** the value must be a **JS‑readable** cookie present at
  the moment the turn starts (the consumer already went through whatever set it,
  e.g. an OAuth consent that dropped the cookie). If it was set `HttpOnly`, the
  browser path can't forward it — the flow won't see it.
- **Name the cookies you need** (shape 1 with an allow‑list) rather than forwarding
  everything, so unrelated cookies don't ride along.
