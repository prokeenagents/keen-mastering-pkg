/**
 * agent-runner debug — the MANUAL attach half of the debuggers. The Keen VS Code
 * extension signs in and connects for you; this prints the same attach address
 * for any other client (a hand-written launch.json, a CDP tool). It reads the
 * flow project's `.vscode/keen.json` and speaks the org API directly:
 * login (user + password → access token) → debug ticket (one connection, 5 min)
 * → logout (ALWAYS — the CLI never keeps an org session) → the mode probe: a
 * Keen 15.3+ server serves both debuggers on its 443 edge,
 * https://<server>/keen-debug/<kind>/dbg/<ticket>; an older one only on the
 * ports :7101 (flow) / :7100 (script). The probe is the discovery GET
 * <edge>/dbg/<ticket>/json (it does not use the ticket up): a JSON target list
 * = the edge; a 3xx / 404 / HTML page = no edge → the ports, with the same ticket.
 *
 *   npx tsx debug.ts --kind=flow   --project ./my-flow-project
 *   npx tsx debug.ts --kind=script --project ./my-flow-project --json
 *
 * Config (flag first, then .env):
 *   --kind                             flow or script
 *   --project     / KEEN_PROJECT_DIR   the flow project ROOT (the folder with .vscode/keen.json)
 *   --json                             NDJSON output for the agent
 *
 * `keen.json` gives `server` (https://<host>), `space`, `user` (your console
 * e-mail), `password` and, optionally, `debugHost` (the host name for the port
 * fallback, instead of `server`'s). The password, the access token and the refresh token
 * are NEVER printed; the ticket appears only inside the attach URL / snippet.
 *
 * Two-step sign-in: an account with it is asked its code after the password — on the
 * terminal (`r` + Enter = a new e-mailed code), or from the environment variable
 * KEEN_MFA_CODE for a run without a terminal (read once, never printed).
 */
import 'dotenv/config';

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { ENROLL_FIRST, MFA_CODE_ENV, type CodeAnswer, type MfaMethod, askCodeOnTty, loginStep, normalizeCode } from './mfa-prompt';

/** dotenv does NOT expand ~ — a value like `~/Desktop/BuildTest` arrives literal, so do it here. */
function expandTilde(p: string): string {
    if (p === '~') {
        return homedir();
    }
    if (p.startsWith('~/') || p.startsWith('~\\')) {
        return join(homedir(), p.slice(2));
    }
    return p;
}

// ------------------------------------------------------------------ args

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): Args {
    const args: Args = {};
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith('--')) {
            continue;
        }
        const eq = token.indexOf('=');
        if (eq > 2) {
            args[token.slice(2, eq)] = token.slice(eq + 1); // --key=value
            continue;
        }
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
            args[key] = true;
        } else {
            args[key] = next;
            i++;
        }
    }
    return args;
}

/** Bad arguments / configuration — exit 2, nothing was sent. */
function fail(message: string): never {
    process.stderr.write(`agent-runner debug: ${message}\n`);
    process.exit(2);
}

const USAGE = `debug.ts — get a one-time attach address for the flow or script debugger (a manual attach;
the Keen VS Code extension signs in and connects for you).

USAGE
  npx tsx debug.ts --kind=flow|script [--project <dir>] [--json]

CONFIG (flag first, then .env; --key value or --key=value)
  --kind                              flow (the flow debugger) or script (the script debugger)
  --project      / KEEN_PROJECT_DIR   the flow project ROOT — the folder that holds .vscode/keen.json (default: .)
  --json                              NDJSON output for the agent
  -h --help                           this help
  KEEN_MFA_CODE  (environment)        the two-step sign-in code for a run without a terminal — used once, never printed

.vscode/keen.json (a local secrets file — keep it git-ignored, never commit it)
  server    https://<host> of your Keen sandbox          user      your console account e-mail
  space     the space id — the ONLY space this debugger stops in    password  that account's password
  token     the deployment token (not used here)
  debugHost optional — the host name for the port fallback (an older server), default server's host

WHAT IT DOES
  POST <server>/keen-org-api/v1/auth/login       { email: user, password }   → an access token
       — with two-step sign-in: asks the code (the authenticator app, or the e-mail: r + Enter = a new code)
  POST <server>/keen-org-api/v1/auth/login/verify { challenge, code }        → an access token
  POST <server>/keen-org-api/v1/debug/ticket     { kind, space }             → a ticket
  POST <server>/keen-org-api/v1/auth/logout      (always — no org session is kept)
  GET  <server>/keen-debug/<kind>/dbg/<ticket>/json   the mode probe (does not use the ticket up)
  Then prints the attach address — on the TLS edge (Keen 15.3+):
    flow:   https://<server>/keen-debug/flow/dbg/<ticket>
    script: wss://<server>/keen-debug/script/dbg/<ticket>/ws  plus a ready launch.json configuration
  When the probe finds no edge (a 3xx, a 404 or an HTML page: an older server), the ports, same ticket:
    flow:   http://<debugHost>:7101/dbg/<ticket>      script: ws://<debugHost>:7100/dbg/<ticket>/ws
  The address is valid for ONE connection within 5 minutes; run this again for the next attach.
  The debugger stops only runs of "space", and only the scripts / flow nodes your breakpoints are
  set on; every other run runs normally. One debugger window per kind at a time — a second one is
  closed with "Debugger in use".

  Needs: the debugger switched ON by the owner or an admin (console → Debugger page) and a
  role with the Debugger permission. The password, the code and the tokens are never printed.
  An organization that requires two-step sign-in refuses an account without it: set it up in the
  console first (My Account › Security).

EXIT CODES
  0  the attach address was printed
  1  refused (bad credentials or code, no code given, two-step sign-in not set up, too many sign-in
     attempts, no Debugger permission, the debugger is off, the debugger refused the ticket) or the call
     failed (network, TLS, HTTP status)
  2  bad arguments / configuration, a KEEN_MFA_CODE that is not 6 digits (nothing was sent)

For a self-signed dev cert, prefix the command with NODE_TLS_REJECT_UNAUTHORIZED=0.
Full docs: agent-runner/docs/DEBUG.md
`;

// ------------------------------------------------------------------ emit

function makeEmitter(json: boolean) {
    return (t: string, payload: Record<string, unknown>): void => {
        if (json) {
            process.stdout.write(JSON.stringify({ t, ...payload }) + '\n');
        } else {
            const detail = Object.entries(payload)
                .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
                .join('  ');
            process.stdout.write(`[${t}] ${detail}\n`);
        }
    };
}

// ------------------------------------------------------------------ http

async function post(url: string, headers: Record<string, string>, body?: BodyInit): Promise<{ status: number; json: unknown; text: string }> {
    const res = await fetch(url, { method: 'POST', headers, body });
    const text = await res.text();
    let parsed: unknown = null;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch {
        parsed = null;
    }
    return { status: res.status, json: parsed, text };
}

const JSON_HEADERS = { 'content-type': 'application/json' };

/** The org API's refusal text — the envelope's / Nest's `message` (a string or a validation list), never the raw body. */
function messageOf(json: unknown): string {
    const message = (json as { message?: unknown } | null)?.message;
    if (typeof message === 'string') {
        return message;
    }
    if (Array.isArray(message)) {
        return message.filter(m => typeof m === 'string').join('; ');
    }
    return '';
}

/** The success envelope's `result` (`{ success, status, message, result }`). */
function resultOf<T>(json: unknown): T | undefined {
    return (json as { result?: T } | null)?.result;
}

// ------------------------------------------------------------------ keen.json

type KeenJson = { server: string; space: string; user: string; password: string; debugHost: string };

/** A host name only — no scheme, no port, no path (`keen.json` `debugHost`). */
const HOST_NAME_RE = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

async function readKeenJson(projectDir: string): Promise<KeenJson> {
    const file = join(projectDir, '.vscode', 'keen.json');
    let raw: string;
    try {
        raw = await readFile(file, 'utf8');
    } catch {
        fail(`no ${file} — --project / KEEN_PROJECT_DIR must be the flow project ROOT (the folder that holds .vscode/keen.json)`);
    }
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
        fail(`${file} is not valid JSON`);
    }
    const field = (key: string): string => (typeof parsed[key] === 'string' ? (parsed[key] as string).trim() : '');
    const value: KeenJson = {
        server: field('server'),
        space: field('space'),
        user: field('user'),
        password: typeof parsed.password === 'string' ? parsed.password : '',
        debugHost: field('debugHost')
    };

    if (!value.server || value.server.includes('REPLACE_WITH')) {
        fail(`${file} has no "server" — set it to your Keen sandbox, e.g. https://keen.example.com`);
    }
    if (!value.user || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.user)) {
        fail(`${file} has no "user" e-mail — add "user": "<your console account e-mail>"`);
    }
    if (!value.password) {
        fail(`${file} has no "password" — add "password": "<that account's password>" (keep keen.json git-ignored)`);
    }
    if (value.debugHost && !HOST_NAME_RE.test(value.debugHost)) {
        fail(`${file} "debugHost" must be a host name only (no scheme, port or path), e.g. keen.example.com`);
    }
    return value;
}

// ------------------------------------------------------------------ main

const jsonOut = process.argv.includes('--json');

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args.help === true || process.argv.includes('-h')) {
        process.stdout.write(USAGE);
        process.exit(0);
    }
    const json = args.json === true;
    const emit = makeEmitter(json);

    const kind = typeof args.kind === 'string' ? args.kind : '';
    if (kind !== 'flow' && kind !== 'script') {
        fail('missing or wrong --kind — flow (the flow debugger) or script (the script debugger)');
    }

    const fromArg = args.project;
    const projectDir = resolve(expandTilde((typeof fromArg === 'string' && fromArg) || process.env.KEEN_PROJECT_DIR || '.'));
    const dirStat = await stat(projectDir).catch(() => null);
    if (!dirStat?.isDirectory()) {
        fail(`--project is not a directory: ${projectDir}`);
    }

    const config = await readKeenJson(projectDir);
    let serverUrl: URL;
    try {
        serverUrl = new URL(/^[a-z]+:\/\//i.test(config.server) ? config.server : `https://${config.server}`);
    } catch {
        fail(`"server" in .vscode/keen.json is not a URL: ${config.server}`);
    }
    if (!config.space || config.space.includes('REPLACE_WITH')) {
        fail('the debugger needs a real "space" in .vscode/keen.json — it stops only runs of that space');
    }

    // The code for a run without a terminal — taken once and removed from the environment (never printed).
    const envCode = process.env[MFA_CODE_ENV];
    delete process.env[MFA_CODE_ENV];
    if (envCode !== undefined && normalizeCode(envCode) === null) {
        fail(`${MFA_CODE_ENV} must be the 6-digit code`);
    }

    const base = `${serverUrl.origin}/keen-org-api/v1`;
    const debugHost = config.debugHost || serverUrl.hostname;

    // 1) login — the console account in keen.json; the reply's tokens never reach the output.
    emit('meta', { step: 'login', server: serverUrl.origin, user: config.user });
    const tokens = await signIn(emit, base, config, envCode);
    if (!tokens) {
        process.exit(1);
    }

    let code = 0;
    let granted: { ticket: string; expiresIn: number } | undefined;
    try {
        // 2) the ticket — ms-auth re-checks the account, the Debugger permission and the switch.
        emit('meta', { step: 'ticket', kind, space: config.space });
        const ticketRes = await post(`${base}/debug/ticket`, { ...JSON_HEADERS, authorization: `Bearer ${tokens.access_token}` }, JSON.stringify({ kind, space: config.space }));
        const ticket = resultOf<{ ticket?: string; expires_in?: number }>(ticketRes.json);

        if (ticketRes.status === 200 && ticket?.ticket) {
            granted = { ticket: ticket.ticket, expiresIn: typeof ticket.expires_in === 'number' ? ticket.expires_in : 300 };
        } else {
            code = 1;
            const message = messageOf(ticketRes.json);
            let reason = message || `HTTP ${ticketRes.status}`;
            if (ticketRes.status === 403 && message === 'Debugger is off') {
                reason = 'the debugger is off — ask the owner or an admin to switch it on in the console (the Debugger page)';
            } else if (ticketRes.status === 403) {
                reason = 'Forbidden — your role has no Debugger permission (ask the owner or an admin), or this is not a human console account';
            } else if (ticketRes.status === 404) {
                reason = `space "${config.space}" was not found — check "space" in .vscode/keen.json`;
            } else if (ticketRes.status === 406) {
                reason = 'the platform refused the request (406) — is "space" a space id?';
            } else if (ticketRes.status === 503 && /Spaces channel unavailable/i.test(message)) {
                reason = 'the platform could not check the space — try again in a minute';
            } else if (ticketRes.status === 401) {
                reason = 'the access token was refused — sign in again (run this again)';
            }
            emit('fail', { step: 'ticket', status: ticketRes.status, reason });
        }
    } finally {
        // 3) logout — ALWAYS; ends the session the login opened (ms-auth answers 200 whatever happens).
        if (tokens.refresh_token) {
            await post(`${base}/auth/logout`, JSON_HEADERS, JSON.stringify({ refresh_token: `Bearer ${tokens.refresh_token}` })).catch(() => undefined);
        }
    }

    if (granted) {
        code = await attach(emit, json, kind, config.space, serverUrl, debugHost, granted);
    }

    setTimeout(() => process.exit(code), 50);
}

// ------------------------------------------------------------------ sign-in

type Tokens = { access_token: string; refresh_token?: string };

/** The words of every refused sign-in — the same for a wrong password and a wrong code (never which part failed). */
const BAD_CREDENTIALS = 'bad credentials — check "user" and "password" in .vscode/keen.json (your console account)';

/** The most prompts one sign-in asks (each resend re-asks; the platform allows 3 resends). */
const MAX_PROMPTS = 6;

/** The sign-in throttle's `retryAfter` seconds, when present. */
function retryAfterOf(json: unknown): number | undefined {
    const value = Number((json as { retryAfter?: unknown } | null)?.retryAfter);
    return Number.isFinite(value) && value > 0 ? Math.ceil(value) : undefined;
}

/** The reason of a refused login / verify / resend answer. */
function signInRefusal(status: number, json: unknown): string {
    // ms-auth answers every wrong e-mail / password / code / blocked account with the same 406 (an edge 401 / 400 means the same to you).
    if (status === 401 || status === 406 || status === 400) {
        return BAD_CREDENTIALS;
    }
    if (status === 429) {
        // The sign-in throttle (per address and per e-mail) — never retry in a loop, it only lengthens the block.
        const retryAfter = retryAfterOf(json);
        return `too many sign-in attempts — wait${retryAfter ? ` ${retryAfter} s` : ' a while'}, then run this again`;
    }
    return messageOf(json) || 'login failed';
}

/**
 * Login → the tokens; for an account with two-step sign-in the code (KEEN_MFA_CODE once, else the terminal prompt)
 * → `/auth/login/verify`. Emits the `fail` line and answers undefined on any refusal. The code and the challenge
 * never reach the output.
 */
async function signIn(emit: ReturnType<typeof makeEmitter>, base: string, config: KeenJson, envCode: string | undefined): Promise<Tokens | undefined> {
    const loginRes = await post(`${base}/auth/login`, JSON_HEADERS, JSON.stringify({ email: config.user, password: config.password }));
    if (loginRes.status !== 200) {
        emit('fail', { step: 'login', status: loginRes.status, reason: signInRefusal(loginRes.status, loginRes.json) });
        return undefined;
    }

    const step = loginStep(loginRes.json);
    if (step.kind === 'enroll') {
        emit('fail', { step: 'login', status: 202, reason: ENROLL_FIRST });
        return undefined;
    }
    if (step.kind === 'pair') {
        if (!step.tokens?.access_token) {
            emit('fail', { step: 'login', status: 200, reason: 'login failed' });
            return undefined;
        }
        return { access_token: step.tokens.access_token, refresh_token: step.tokens.refresh_token };
    }

    emit('meta', { step: 'verify', method: step.method });
    const ask = codeSource(step.method, envCode);
    if (!ask) {
        emit('fail', { step: 'verify', reason: `this account signs in in two steps — run this in a terminal to enter the code, or set ${MFA_CODE_ENV} for one run` });
        return undefined;
    }

    let note: string | undefined;
    for (let prompts = 0; prompts < MAX_PROMPTS; prompts++) {
        const answer = await ask(note);
        if (!answer) {
            emit('fail', { step: 'verify', reason: 'no code entered — run this again' });
            return undefined;
        }
        if ('resend' in answer) {
            const resent = await post(`${base}/auth/login/resend`, JSON_HEADERS, JSON.stringify({ challenge: step.challenge }));
            if (resent.status === 200) {
                note = 'A new code is on its way.';
            } else if (resent.status === 429) {
                const retryAfter = retryAfterOf(resent.json);
                note = retryAfter ? `A new code can be sent in ${retryAfter} s — enter the last one meanwhile.` : 'No new code can be sent now — enter the last one.';
            } else {
                emit('fail', { step: 'verify', status: resent.status, reason: signInRefusal(resent.status, resent.json) });
                return undefined;
            }
            emit('meta', { step: 'resend', sent: resent.status === 200 });
            continue;
        }
        const verified = await post(`${base}/auth/login/verify`, JSON_HEADERS, JSON.stringify({ challenge: step.challenge, code: answer.code }));
        const pair = resultOf<{ access_token?: string; refresh_token?: string }>(verified.json);
        if (verified.status !== 200 || !pair?.access_token) {
            emit('fail', { step: 'verify', status: verified.status, reason: verified.status === 200 ? 'login failed' : signInRefusal(verified.status, verified.json) });
            return undefined;
        }
        return { access_token: pair.access_token, refresh_token: pair.refresh_token };
    }
    emit('fail', { step: 'verify', reason: 'no code entered — run this again' });
    return undefined;
}

/**
 * Where the code comes from: KEEN_MFA_CODE (ONE answer — a refused code is not asked again), else the terminal
 * prompt (stdin, the prompt on stderr), else nothing (no terminal, no variable).
 */
function codeSource(method: MfaMethod, envCode: string | undefined): ((note: string | undefined) => Promise<CodeAnswer>) | undefined {
    if (envCode !== undefined) {
        let used = false;
        return () => {
            if (used) {
                return Promise.resolve(undefined);
            }
            used = true;
            const code = normalizeCode(envCode);
            return Promise.resolve(code ? { code } : undefined);
        };
    }
    if (process.stdin.isTTY) {
        return note => askCodeOnTty(method, note, process.stdin, process.stderr);
    }
    return undefined;
}

// ------------------------------------------------------------------ attach

/** The plain debug ports of the twins — only an older server (no 443 edge) is reached on them. */
const DEBUG_PORTS = { flow: 7101, script: 7100 } as const;

/** How long the mode probe may take. */
const PROBE_TIMEOUT_MS = 4000;

/**
 * What the mode probe's answer says (the discovery GET `<edge>/dbg/<ticket>/json`, the same for both kinds):
 *   - `edge` — 200 with a JSON array (a CDP target list): the debugger is behind the server's 443 edge;
 *   - `missing` — any 3xx (an older console redirects to /login; never followed), a 404, or a 200 that is not a
 *     JSON array (an HTML page): this server has no edge → the ports, with the SAME ticket;
 *   - `answer` — anything else (401 / 403 = the debugger's own refusal, 429 = the edge's rate limit, 5xx = down).
 */
function edgeProbe(status: number, text: string): 'edge' | 'missing' | 'answer' {
    if ((status >= 300 && status < 400) || status === 404) {
        return 'missing';
    }
    if (status !== 200) {
        return 'answer';
    }
    try {
        return Array.isArray(JSON.parse(text)) ? 'edge' : 'missing';
    } catch {
        return 'missing';
    }
}

/**
 * 4) Probe the edge, then print the attach address of the mode found (and, for the script debugger, a launch.json
 * configuration). Discovery does not use the ticket up — only the debugger's WebSocket upgrade does. Returns the exit code.
 */
async function attach(
    emit: ReturnType<typeof makeEmitter>,
    json: boolean,
    kind: 'flow' | 'script',
    space: string,
    serverUrl: URL,
    debugHost: string,
    granted: { ticket: string; expiresIn: number }
): Promise<number> {
    const ticket = encodeURIComponent(granted.ticket);
    const edgeBase = `${serverUrl.origin}/keen-debug/${kind}`;
    const probe = await fetch(`${edgeBase}/dbg/${ticket}/json`, { redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const verdict = edgeProbe(probe.status, await probe.text().catch(() => ''));

    if (verdict === 'answer') {
        let reason = `the debugger refused the connection (HTTP ${probe.status}) — run this again for a new ticket`;
        if (probe.status === 429) {
            reason = 'too many debugger requests from this address — wait a minute, then run this again';
        } else if (probe.status >= 500) {
            reason = 'the debugger is not reachable right now — try again in a minute';
        }
        emit('fail', { step: 'probe', status: probe.status, reason });
        return 1;
    }

    const mode = verdict === 'edge' ? 'edge' : 'ports';
    if (mode === 'ports') {
        emit('meta', { step: 'probe', mode, note: `no debug edge on this server (HTTP ${probe.status}) — using the port ${DEBUG_PORTS[kind]} on ${debugHost}` });
    }
    const flowBase = mode === 'edge' ? edgeBase : `http://${debugHost}:${DEBUG_PORTS.flow}`;
    const scriptBase = mode === 'edge' ? edgeBase.replace(/^http/, 'ws') : `ws://${debugHost}:${DEBUG_PORTS.script}`;
    const expiresIn = granted.expiresIn;
    const note = `valid for one connection within ${Math.round(expiresIn / 60)} minutes`;

    if (kind === 'flow') {
        emit('attach', { kind, space, mode, url: `${flowBase}/dbg/${ticket}`, expiresIn, note });
        return 0;
    }

    const websocketAddress = `${scriptBase}/dbg/${ticket}/ws`;
    const launch = {
        type: 'node',
        request: 'attach',
        name: 'Keen Script Debugger',
        websocketAddress,
        continueOnAttach: true,
        skipFiles: ['<node_internals>/**'],
        sourceMaps: true,
        localRoot: '${workspaceFolder}/src',
        remoteRoot: `/app/projects/${space}`
    };
    emit('attach', { kind, space, mode, url: websocketAddress, expiresIn, note });
    if (json) {
        emit('launch', { configuration: launch });
    } else {
        process.stdout.write(`\nlaunch.json configuration (add it to "configurations", then start it within the 5 minutes):\n${JSON.stringify(launch, null, 4)}\n`);
    }
    return 0;
}

// A thrown error here is the network / TLS / runtime failing mid-call (fetch
// rejects) — exit 1 like any other failed call; 2 stays for bad arguments.
main().catch(err => {
    let message = err instanceof Error ? (err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message) : String(err);
    if (/self[- ]signed|certificate/i.test(message)) {
        message += ' — for a self-signed dev cert, prefix the command with NODE_TLS_REJECT_UNAUTHORIZED=0';
    }
    if (jsonOut) {
        process.stdout.write(JSON.stringify({ t: 'fail', step: 'request', error: message }) + '\n');
    } else {
        process.stderr.write(`agent-runner debug: ${message}\n`);
    }
    process.exit(1);
});
