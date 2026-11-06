/**
 * The two-step sign-in code for `debug.ts` — the prompt and the pieces of the second step that need no network.
 *
 * A console account with two-step sign-in answers the login with `statusCode 201 'Verify'` + `{ challenge, method }`
 * (the method = `totp`, an authenticator app, or `email`, a mailed code) instead of the tokens; the code then goes to
 * `POST /auth/login/verify { challenge, code }`. An account the organization requires it of, without it set up, gets
 * `statusCode 202 'Enroll'` — that is done in the console, never here.
 *
 * The code is never printed and never stored: the terminal echoes what you type, nothing else sees it.
 */
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

/** Where the code comes from. */
export type MfaMethod = 'totp' | 'email';

/** The prompt's answer: a 6-digit code, a request for a new mailed code, or `undefined` (an empty line / end of input). */
export type CodeAnswer = { code: string } | { resend: true } | undefined;

/** What the login's 200 answer says next. */
export type LoginStep = { kind: 'pair'; tokens?: { access_token?: string; refresh_token?: string } } | { kind: 'verify'; challenge: string; method: MfaMethod } | { kind: 'enroll' };

/** The refusal of a login that asks to set up two-step sign-in first. */
export const ENROLL_FIRST = 'set up two-step sign-in in the console first (My Account › Security), then run this again';

/** The environment variable that carries the code for a run without a terminal (read once, then removed). */
export const MFA_CODE_ENV = 'KEEN_MFA_CODE';

/** How often the prompt re-asks a value that is not 6 digits before it gives up. */
const MAX_BAD_INPUTS = 3;

/**
 * A 6-digit code from what was typed (spaces dropped: apps show `123 456`), or null.
 */
export function normalizeCode(value: string): string | null {
    const code = value.replace(/\s+/g, '');
    return /^\d{6}$/.test(code) ? code : null;
}

/**
 * The prompt text — it names where the code comes from.
 */
export function codePromptText(method: MfaMethod): string {
    return method === 'email' ? 'Enter the code we e-mailed to you' : 'Enter the code from your authenticator app';
}

/**
 * Read the login's 200 envelope: `statusCode 201 'Verify'` (+ a challenge) → the code step, `statusCode 202 'Enroll'` →
 * the enroll refusal, anything else → the tokens as before.
 */
export function loginStep(json: unknown): LoginStep {
    const envelope = (json ?? {}) as { statusCode?: unknown; message?: unknown; result?: { challenge?: unknown; method?: unknown; access_token?: string; refresh_token?: string } };
    const statusCode = Number(envelope.statusCode);
    if (statusCode === 202 || envelope.message === 'Enroll') {
        return { kind: 'enroll' };
    }
    if (statusCode === 201 || envelope.message === 'Verify') {
        const challenge = envelope.result?.challenge;
        if (typeof challenge === 'string' && challenge) {
            return { kind: 'verify', challenge, method: envelope.result?.method === 'email' ? 'email' : 'totp' };
        }
    }
    return { kind: 'pair', tokens: envelope.result };
}

/**
 * Ask the code on a terminal: `input` = stdin, `output` = stderr (stdout stays the NDJSON / attach output). For an
 * e-mailed code `r` + Enter asks for a new one. `note` = a line about the last resend, shown before the prompt.
 * A value that is not 6 digits is asked again (at most {@link MAX_BAD_INPUTS} times); an empty line or the end of the
 * input = `undefined` (cancelled).
 */
export async function askCodeOnTty(method: MfaMethod, note: string | undefined, input: Readable, output: Writable): Promise<CodeAnswer> {
    const rl = createInterface({ input, output, terminal: false });
    const lines = rl[Symbol.asyncIterator]();
    const hint = method === 'email' ? ' (r + Enter = send a new code)' : '';
    try {
        if (note) {
            output.write(`${note}\n`);
        }
        for (let tries = 0; tries < MAX_BAD_INPUTS; tries++) {
            output.write(`${codePromptText(method)}${hint}: `);
            const next = await lines.next();
            if (next.done) {
                return undefined;
            }
            const value = String(next.value).trim();
            if (!value) {
                return undefined;
            }
            if (method === 'email' && value.toLowerCase() === 'r') {
                return { resend: true };
            }
            const code = normalizeCode(value);
            if (code) {
                return { code };
            }
            output.write('The code is 6 digits.\n');
        }
        return undefined;
    } finally {
        rl.close();
    }
}
