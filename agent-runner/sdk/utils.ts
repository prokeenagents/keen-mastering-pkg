import { CHAT_SETTINGS } from './settings';

/**
 * An RFC-4122 v4 UUID from `crypto.getRandomValues` — the Web Crypto global,
 * present in every supported browser and in Node >= 19.
 *
 * Deliberately NOT `crypto.randomUUID()`: that one is SECURE-CONTEXT-ONLY, so on
 * a plain-http origin (a LAN dev host, say) it is `undefined` and throws on the
 * first call. `getRandomValues` carries no such restriction and behaves the same
 * over http and https. The version (4) and variant (10xx) bits are set by hand to
 * make the random bytes a valid v4.
 *
 * Deliberately duplicated here rather than imported from the host app: this SDK
 * is self-contained (every import is relative) so it can be lifted out into its
 * own package as-is. Reaching into the consumer's `@/utils` would break that.
 */
export function generateUUID(): string {
    const bytes = new Uint8Array(16);

    crypto.getRandomValues(bytes);

    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx

    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0'));

    return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

/**
 * Generate a globally-unique request id of the form r-<uuid>. It MUST be
 * unique across browser tabs/sessions — not merely within one tab —
 * because the engine's ProcessCoordinator dedups in-flight work by
 * requestId ALONE (process-global, not per-connection). The old
 * `r-<base36 time>-<seq>` counter was per-tab only, so N tabs running in
 * lockstep minted identical ids; the engine then rejected the collision
 * as a spurious E2003 "Duplicate requestId", which the client treats as a
 * flow failure and cancels the whole cid, cascading into E6002 "flow
 * cancelled or stale" on every sibling clone. A v4 UUID is unique across
 * tabs. Minted once per SendRequest and reused across that request's
 * retries, so the engine's intended same-id retry dedup still holds.
 */
export function generateRequestId(): string {
    return `r-${generateUUID()}`;
}

/**
 * Read the browser's cookies as a flat { name: value } map. Forwarded on
 * the initial run so script nodes can read them via system/cookies. Note:
 * HttpOnly cookies are NOT visible to document.cookie and will not appear
 * here — only JS-readable cookies are forwarded.
 *
 * `allow` is an optional allow-list of cookie NAMES: when provided (even
 * empty), ONLY those names are forwarded; when `undefined`, every JS-readable
 * cookie is forwarded. So `[]` forwards nothing and omitting it forwards all.
 */
export function readBrowserCookies(allow?: readonly string[]): Record<string, string> {
    if (typeof document === 'undefined' || !document.cookie) {
        return {};
    }
    const filter = allow ? new Set(allow) : null;
    const out: Record<string, string> = {};
    for (const part of document.cookie.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) {
            continue;
        }
        const name = part.slice(0, idx).trim();
        if (!name || (filter && !filter.has(name))) {
            continue;
        }
        out[name] = decodeURIComponent(part.slice(idx + 1).trim());
    }
    return out;
}

/**
 * Resolve the `requestContext.cookies` map for the initial run from the
 * caller's cookie config. An explicit `{ name: value }` MAP is used AS-IS (no
 * browser needed — this is how a headless caller / a building agent supplies a
 * cookie a real user's browser would otherwise carry); a list of NAMES (or
 * nothing) reads the browser's document.cookie, optionally filtered to those
 * names.
 */
export function resolveRequestCookies(config?: readonly string[] | Record<string, string>): Record<string, string> {
    if (config && !Array.isArray(config)) {
        return { ...(config as Record<string, string>) };
    }

    return readBrowserCookies(config as readonly string[] | undefined);
}

/**
 * A NON-RETRYABLE send failure — the frame cannot be delivered and retrying
 * would loop forever (e.g. it exceeds the transport's payload cap). The retry
 * loops in SendRequest and TaskQueue re-throw this instead of retrying, so the
 * run aborts cleanly with a clear reason.
 */
export class FatalSendError extends Error {
    readonly fatal = true as const;

    constructor(message: string) {
        super(message);
        this.name = 'FatalSendError';
    }
}

/**
 * The failure texts of a lost connection — a contract:
 * sites match on them.
 */
export const CONNECTION_LOST_TEXT = {
    /** `resume-refused` `gone` / `protocol`: the grace ran out, or a cancel came first. */
    GONE: 'connection lost — the server no longer holds this flow',
    /** Close 4409: this cid was resumed on a newer connection. */
    SUPERSEDED: 'connection taken over by another session',
    /** A drop during a running flow on a relay whose welcome carries no `protocol`. */
    OLD_RELAY: 'connection lost — this Keen server cannot resume a flow',
    /** A token refusal whose refresh (`onAuthExpired`) answered null. */
    INVALID_TOKEN: 'Invalid token'
} as const;

/**
 * The flow's correlationID can no longer be driven from this client: the
 * server ended it (`gone`), refused the resume for good (`protocol`, a token
 * whose refresh answered null), another connection took it over (4409), or the
 * relay cannot resume (an old relay). FATAL like FatalSendError: the node
 * retry loops re-throw it, and the run's catch does NOT send a cancel — the
 * cid is not attached to this socket any more.
 *
 * `restartable` marks the gone / protocol refusals: if the only frame ever
 * sent on the old cid was the run frame and no reply came, the flow had not
 * started, so TaskQueue re-sends the start on the NEW cid.
 */
export class ConnectionLostError extends Error {
    readonly fatal = true as const;
    readonly code: string;
    readonly restartable: boolean;

    constructor(message: string, opts: { code?: string; restartable?: boolean } = {}) {
        super(message);
        this.name = 'ConnectionLostError';
        this.code = opts.code ?? 'E5201';
        this.restartable = opts.restartable === true;
    }
}

/**
 * The pause before the n-th reconnect attempt: the same
 * full-jitter curve as the response retries — random in [0, min(10 s, 1 s × 2^(n−1))].
 */
export function reconnectDelayMs(attempt: number, random?: () => number): number {
    return retryBackoffMs(attempt, {
        baseMs: CHAT_SETTINGS.RECONNECT_BASE_MS,
        maxMs: CHAT_SETTINGS.RECONNECT_MAX_MS,
        random
    });
}

/** UTF-8 byte length of a string, without allocating a second big buffer where
 *  possible (Buffer in Node, Blob in the browser, TextEncoder as the fallback). */
export function byteLength(text: string): number {
    if (typeof Buffer !== 'undefined') {
        return Buffer.byteLength(text, 'utf8');
    }
    if (typeof Blob !== 'undefined') {
        return new Blob([text]).size;
    }

    return new TextEncoder().encode(text).length;
}

/**
 * Promise-based sleep used by SendRequest's retry loop. Returns once
 * the given number of milliseconds has elapsed.
 */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/**
 * The pause before a CONTINUATION's next response retry (Keen 15.3 decision
 * 44): exponential backoff with FULL jitter. `failures` = the failures in a row
 * so far (1 after the first). The cap doubles from the base — 1 → 2 → 4 → 8 →
 * 10 s — and the pause is random in [0, cap], so N clients refused together
 * never retry in lockstep. A `hintMs` (an E4 refusal's `retryAfterMs`) wins,
 * capped at the same maximum.
 */
export function retryBackoffMs(
    failures: number,
    opts: { baseMs: number; maxMs: number; hintMs?: number | null; random?: () => number }
): number {
    if (typeof opts.hintMs === 'number' && Number.isFinite(opts.hintMs) && opts.hintMs >= 0) {
        return Math.min(opts.maxMs, Math.floor(opts.hintMs));
    }

    const cap = Math.min(opts.maxMs, opts.baseMs * Math.pow(2, Math.max(0, failures - 1)));

    return Math.floor((opts.random ?? Math.random)() * cap);
}

/**
 * A refusal's retry hint, when the server sends one: `retryAfterMs` on an
 * E4xxx envelope (top level, or under `details`). Null otherwise — the relay
 * does not send one today; the SDK honours it when it does.
 */
export function retryAfterHintMs(envelope: unknown): number | null {
    if (!envelope || typeof envelope !== 'object') {
        return null;
    }

    const env = envelope as { code?: unknown; retryAfterMs?: unknown; details?: { retryAfterMs?: unknown } | null };

    if (typeof env.code !== 'string' || !env.code.startsWith('E4')) {
        return null;
    }

    const hint = env.retryAfterMs ?? env.details?.retryAfterMs;

    return typeof hint === 'number' && Number.isFinite(hint) && hint >= 0 ? hint : null;
}

/**
 * Format the current wall clock as HH:MM:SS.mmm. Shared between the
 * Connect class's system-emit messages and the UI log timestamps.
 */
export function timestamp(): string {
    const d = new Date();
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');

    return `${h}:${m}:${s}.${ms}`;
}
