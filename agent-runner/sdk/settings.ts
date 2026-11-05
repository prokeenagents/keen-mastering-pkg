/**
 * CHAT_SETTINGS — every tunable constant the chat SDK uses, in one place.
 *
 * These are the DEFAULTS the SDK falls back to when a caller doesn't specify a
 * value. They live inside the SDK (not in the app's `configs/`) so it stays
 * self-contained — a `new ChatAPI({ ... })` needs to pass only what differs from
 * these. Override per-deployment through `ChatAPIOptions` rather than editing the
 * numbers here.
 */
export const CHAT_SETTINGS = {
    /**
     * Default Keen server WebSocket endpoint. Override per-deployment via
     * `ChatAPIOptions.url`.
     *
     * Resolved in the BROWSER, so it must name a host the END USER's machine can
     * reach — the same host the app is served from, not `localhost` (in a browser
     * `localhost` is the user's own machine; it works only while you develop on the
     * same box, then fails from a phone or a second laptop).
     *
     * Use `wss://` for an https app — browsers block `ws://` from an https page as
     * mixed content; `ws://` is only for plain-http local dev. The public path is
     * `/ws-keen` (`wss://<your-keen-host>/ws-keen`).
     *
     * The browser's Origin must equal the origin of a webhook record bound to an
     * api_key (the server's allow-list is those origins, exact match), or the server
     * refuses the upgrade and the WS closes 1006 with no explanation.
     */
    WS_URL: 'ws://localhost/ws-keen',

    /**
     * How long ResponseAPI.waitFor() waits for a matching response envelope before
     * rejecting. 10min so a debug pause never trips the per-node retry; drop to
     * 30_000 for normal load testing.
     */
    RESPONSE_TIMEOUT_MS: 600_000,

    /**
     * Fixed pause between retries of the RUN FRAME (the first prompt; 10 × 1 s
     * decides whether the flow starts) and between SendRequest's transport
     * retries (socket not ready).
     */
    RETRY_DELAY_MS: 1_000,

    /**
     * Every NODE's response retries — the root flow's
     * startNode and every `initial: true` node included, since a node belongs to
     * a flow that has already started: exponential
     * backoff with FULL jitter — the pause after the n-th failure in a row is
     * random in [0, min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS × 2^(n−1))],
     * i.e. caps of 1 → 2 → 4 → 8 → 10 s. It resets when the node succeeds
     * (every node starts from the base). A `retryAfterMs` hint on a refusal
     * (E4xxx) is honoured instead, capped at RETRY_MAX_DELAY_MS. The attempt
     * count stays infinite — a started flow is always finished.
     */
    RETRY_BASE_DELAY_MS: 1_000,
    RETRY_MAX_DELAY_MS: 10_000,

    /**
     * Heartbeat cadence while a run is in flight. Fires a 'ping' that refreshes the
     * engine's dict/session TTL (60s) → 12x margin. A protocol-2 relay answers it
     * with a `pong`, which feeds the liveness check (LIVENESS_MS). While the
     * socket is away, the relay keeps the engine TTLs alive itself for its grace
     * (120 s by default).
     */
    HEARTBEAT_INTERVAL_MS: 5_000,

    /**
     * parallelContext fan-out drain batch — at most this many clones in flight at
     * once, so a huge collection never floods the engine. Kept below the engine's
     * 33 admission slots so a single fan-out won't self-reject.
     */
    CONTEXT_BATCH_SIZE: 15,

    /**
     * Bounded attempts for the RUN FRAME (the user's first prompt) — its transport
     * retries and its capacity refusals (E4xxx), 1 s apart. The run frame is the
     * only thing that may be refused: after the 10th refusal the
     * run settles with the refusal ("busy, try again in a minute"). Every node
     * after it retries infinitely — the flow has started and must finish.
     */
    INITIAL_MAX_RETRIES: 10,

    /**
     * Hard cap on a single outbound frame (bytes of its JSON). A frame above
     * this can NEVER traverse the relay→engine hop — NATS enforces max_payload
     * 8MB, so an oversized frame fails DETERMINISTICALLY every time. Because a
     * continuation retries on ANY error with an infinite budget, sending one
     * would loop forever (the relay drops it / closes the socket, never a clean
     * envelope). So the client rejects it UP FRONT as non-retryable instead of
     * hanging. Mirror the server's NATS max_payload; lower it per deployment if
     * a proxy caps smaller.
     */
    MAX_FRAME_BYTES: 8 * 1024 * 1024,

    /**
     * Reconnect after a dropped socket. The pause
     * before the n-th reconnect attempt is random in
     * [0, min(RECONNECT_MAX_MS, RECONNECT_BASE_MS × 2^(n−1))] — the
     * full-jitter curve of the response retries, caps 1 → 2 → 4 → 8 → 10 s — with no attempt limit:
     * while offline the SDK keeps trying at the 10 s cap, and only a server
     * answer ends a started flow. A relay restart (close 1012) reconnects
     * after a jitter of 0–RESTART_JITTER_MS instead. The count resets on a
     * welcome that needs no resume, or on `resumed`.
     */
    RECONNECT_BASE_MS: 1_000,
    RECONNECT_MAX_MS: 10_000,
    RESTART_JITTER_MS: 1_000,

    /**
     * Liveness: while a run is active on a protocol-2 relay (which answers
     * every `ping` with a `pong`), a socket with no inbound frame for this long
     * is taken as dead (a half-open TCP) and closed with 4000, then reconnected
     * and resumed. 3 × HEARTBEAT_INTERVAL_MS.
     */
    LIVENESS_MS: 15_000,

    /**
     * The relay closes a socket with 1008 after 5 refused resumes. The SDK
     * never sends a 6th on the same socket: it opens a new one (with the
     * reconnect backoff) instead.
     */
    RESUME_MAX_ATTEMPTS_PER_SOCKET: 5,

    /**
     * The wire protocol this SDK speaks: 2 = resume / resumed / resume-refused
     * and ping → pong. Sent in every `ping`; a relay's `welcome.protocol`
     * says what it speaks (absent = 1, a relay that cannot resume a flow).
     */
    PROTOCOL: 2
} as const;
