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
     * The browser's Origin must be allow-listed on the api_key, or the server
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
     * Backoff between retries — both SendRequest's transport retries (socket not
     * ready) and TaskQueue's per-node response retries (transient engine error).
     */
    RETRY_DELAY_MS: 1_000,

    /**
     * Heartbeat cadence while a run is in flight. Fires a 'ping' that refreshes the
     * engine's dict/session TTL (60s) → 12x margin, so a live flow survives a brief
     * drop while abandoned state still reclaims within ~a minute.
     */
    HEARTBEAT_INTERVAL_MS: 5_000,

    /**
     * parallelContext fan-out drain batch — at most this many clones in flight at
     * once, so a huge collection never floods the engine. Kept below the engine's
     * 33 admission slots so a single fan-out won't self-reject.
     */
    CONTEXT_BATCH_SIZE: 15,

    /**
     * Bounded retry count for INITIAL-run frames (a failed start means the user's
     * request never began). Continuations retry infinitely instead — the flow is
     * already alive server-side, so we keep trying until the socket recovers.
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
    MAX_FRAME_BYTES: 8 * 1024 * 1024
} as const;
