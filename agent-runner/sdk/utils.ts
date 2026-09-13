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
