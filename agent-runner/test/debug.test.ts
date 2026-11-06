/**
 * debug.ts end to end against a fake Keen server (`npm test`): login → ticket → logout → the mode probe → the attach
 * address. A Keen 15.3+ server answers the probe `GET /keen-debug/<kind>/dbg/<ticket>/json` with a CDP target list (the
 * 443 edge); an older one redirects it to /login (or 404s / serves HTML) → the ports :7101 / :7100 with the same ticket.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), '..');
const TICKET = 'tkt.abc_123-XYZ';
const SPACE = 'space-1';

/** How the fake server answers the mode probe; `calls` records every request line. */
type Probe = { status: number; body?: string; headers?: Record<string, string> };

/** A canned answer of the fake org API. */
type Reply = { status: number; body: unknown };

/** The sign-in legs of the fake (the defaults: a login without two-step sign-in). */
type Auth = { login?: Reply; verify?: (body: Record<string, unknown>) => Reply; resend?: Reply };

const PAIR: Reply = { status: 200, body: { success: true, status: 200, message: 'Success', result: { access_token: 'acc-secret', refresh_token: 'ref-secret' } } };
const DEFAULT_TICKET: Reply = { status: 200, body: { success: true, status: 200, message: 'Success', result: { ticket: TICKET, expires_in: 300, kind: 'flow', space: SPACE, path: `/dbg/${TICKET}` } } };

async function fakeServer(probe: Probe, ticket: Reply = DEFAULT_TICKET, auth: Auth = {}) {
    const calls: { method: string; url: string; body: string }[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        let body = '';
        req.on('data', chunk => (body += chunk));
        req.on('end', () => {
            calls.push({ method: req.method ?? '', url: req.url ?? '', body });
            const send = (status: number, payload: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) => {
                res.writeHead(status, headers);
                res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
            };
            if (req.url === '/keen-org-api/v1/auth/login') {
                const login = auth.login ?? PAIR;
                return send(login.status, login.body);
            }
            if (req.url === '/keen-org-api/v1/auth/login/verify') {
                const answer = auth.verify?.(JSON.parse(body || '{}')) ?? PAIR;
                return send(answer.status, answer.body);
            }
            if (req.url === '/keen-org-api/v1/auth/login/resend') {
                const answer = auth.resend ?? { status: 200, body: { success: true, status: 200, message: 'Success', result: { sent: true } } };
                return send(answer.status, answer.body);
            }
            if (req.url === '/keen-org-api/v1/debug/ticket') {
                return send(ticket.status, ticket.body);
            }
            if (req.url === '/keen-org-api/v1/auth/logout') {
                return send(200, { success: true, status: 200, message: 'Success' });
            }
            if (req.url?.startsWith('/keen-debug/')) {
                return send(probe.status, probe.body ?? '', probe.headers ?? { 'content-type': 'application/json' });
            }
            send(404, '<html>not found</html>', { 'content-type': 'text/html' });
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    return { calls, origin: `http://127.0.0.1:${port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

const dirs: string[] = [];
after(async () => {
    await Promise.all(dirs.map(d => rm(d, { recursive: true, force: true })));
});

async function project(keen: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'debug-test-'));
    dirs.push(dir);
    await mkdir(join(dir, '.vscode'));
    await writeFile(join(dir, '.vscode', 'keen.json'), JSON.stringify({ space: SPACE, user: 'dev@example.com', password: 'pw-secret', token: 't', ...keen }));
    return dir;
}

function runDebug(args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise(resolve => {
        // cwd = the runner (tsx resolves from there); KEEN_PROJECT_DIR / KEEN_MFA_CODE unset so only the test's values count.
        const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
        delete env.KEEN_PROJECT_DIR;
        if (!('KEEN_MFA_CODE' in extraEnv)) {
            delete env.KEEN_MFA_CODE;
        }
        const child = spawn(process.execPath, ['--import', 'tsx', 'debug.ts', ...args], { cwd: RUNNER, env });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', d => (stdout += d));
        child.stderr.on('data', d => (stderr += d));
        child.on('close', code => resolve({ code, stdout, stderr }));
    });
}

const lines = (stdout: string) => stdout.trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>);

test('a 15.3 server: the probe finds the edge → the flow address is <server>/keen-debug/flow/dbg/<ticket>', async () => {
    const srv = await fakeServer({ status: 200, body: JSON.stringify([{ id: 'u1', webSocketDebuggerUrl: 'ws://x/keen-debug/flow/dbg/t/u1' }]) });
    try {
        const dir = await project({ server: srv.origin });
        const out = await runDebug(['--kind=flow', '--project', dir, '--json']);
        assert.equal(out.code, 0, out.stderr);
        const attach = lines(out.stdout).find(l => l.t === 'attach');
        assert.deepEqual(attach, { t: 'attach', kind: 'flow', space: SPACE, mode: 'edge', url: `${srv.origin}/keen-debug/flow/dbg/${TICKET}`, expiresIn: 300, note: 'valid for one connection within 5 minutes' });
        // the probe is the discovery GET, after the logout; the ticket body carries kind + space
        assert.deepEqual(srv.calls.map(c => `${c.method} ${c.url}`), [
            'POST /keen-org-api/v1/auth/login',
            'POST /keen-org-api/v1/debug/ticket',
            'POST /keen-org-api/v1/auth/logout',
            `GET /keen-debug/flow/dbg/${TICKET}/json`
        ]);
        assert.deepEqual(JSON.parse(srv.calls[1].body), { kind: 'flow', space: SPACE });
        // nothing secret on stdout
        assert.ok(!/pw-secret|acc-secret|ref-secret/.test(out.stdout + out.stderr));
    } finally {
        await srv.close();
    }
});

test('a 15.3 server, script: wss-style edge address + a launch.json with that websocketAddress', async () => {
    const srv = await fakeServer({ status: 200, body: '[]' });
    try {
        const dir = await project({ server: srv.origin });
        const out = await runDebug(['--kind=script', '--project', dir, '--json']);
        assert.equal(out.code, 0, out.stderr);
        const all = lines(out.stdout);
        const ws = `${srv.origin.replace(/^http/, 'ws')}/keen-debug/script/dbg/${TICKET}/ws`;
        assert.equal(all.find(l => l.t === 'attach')?.url, ws);
        assert.equal(all.find(l => l.t === 'attach')?.mode, 'edge');
        const launch = all.find(l => l.t === 'launch')?.configuration as Record<string, unknown>;
        assert.equal(launch.websocketAddress, ws);
        assert.equal(launch.remoteRoot, `/app/projects/${SPACE}`);
        assert.equal(srv.calls.at(-1)?.url, `/keen-debug/script/dbg/${TICKET}/json`);
    } finally {
        await srv.close();
    }
});

test('an older server: a 307 to /login (never followed) → the port 7101 on the server host, same ticket', async () => {
    const srv = await fakeServer({ status: 307, headers: { location: '/login' } });
    try {
        const dir = await project({ server: srv.origin });
        const out = await runDebug(['--kind=flow', '--project', dir, '--json']);
        assert.equal(out.code, 0, out.stderr);
        const all = lines(out.stdout);
        assert.equal(all.find(l => l.t === 'meta' && l.step === 'probe')?.mode, 'ports');
        assert.equal(all.find(l => l.t === 'attach')?.url, `http://127.0.0.1:7101/dbg/${TICKET}`);
        assert.ok(!srv.calls.some(c => c.url === '/login'), 'the redirect is not followed');
    } finally {
        await srv.close();
    }
});

test('an older server, script, keen.json debugHost: an HTML page → ws://<debugHost>:7100/dbg/<ticket>/ws', async () => {
    const srv = await fakeServer({ status: 200, body: '<!doctype html><html></html>', headers: { 'content-type': 'text/html' } });
    try {
        const dir = await project({ server: srv.origin, debugHost: 'localhost' });
        const out = await runDebug(['--kind=script', '--project', dir, '--json']);
        assert.equal(out.code, 0, out.stderr);
        const all = lines(out.stdout);
        assert.equal(all.find(l => l.t === 'attach')?.url, `ws://localhost:7100/dbg/${TICKET}/ws`);
        assert.equal((all.find(l => l.t === 'launch')?.configuration as Record<string, unknown>).websocketAddress, `ws://localhost:7100/dbg/${TICKET}/ws`);
    } finally {
        await srv.close();
    }
});

test('the debugger refuses the probe (401) → exit 1, no fallback, no attach line', async () => {
    const srv = await fakeServer({ status: 401, body: '' });
    try {
        const dir = await project({ server: srv.origin });
        const out = await runDebug(['--kind=flow', '--project', dir, '--json']);
        assert.equal(out.code, 1);
        const all = lines(out.stdout);
        assert.equal(all.find(l => l.t === 'fail')?.step, 'probe');
        assert.equal(all.find(l => l.t === 'fail')?.status, 401);
        assert.ok(!all.some(l => l.t === 'attach'));
    } finally {
        await srv.close();
    }
});

test('a refused ticket (Debugger is off) → exit 1, no probe, the logout still sent', async () => {
    const srv = await fakeServer({ status: 200, body: '[]' }, { status: 403, body: { statusCode: 403, message: 'Debugger is off' } });
    try {
        const dir = await project({ server: srv.origin });
        const out = await runDebug(['--kind=flow', '--project', dir, '--json']);
        assert.equal(out.code, 1);
        assert.match(String(lines(out.stdout).find(l => l.t === 'fail')?.reason), /the debugger is off/);
        assert.deepEqual(srv.calls.map(c => c.url), ['/keen-org-api/v1/auth/login', '/keen-org-api/v1/debug/ticket', '/keen-org-api/v1/auth/logout']);
    } finally {
        await srv.close();
    }
});

test('a debugHost that is not a host name → exit 2, nothing sent', async () => {
    const dir = await project({ server: 'https://keen.example.com', debugHost: 'http://keen.example.com:7101' });
    const out = await runDebug(['--kind=flow', '--project', dir, '--json']);
    assert.equal(out.code, 2);
    assert.match(out.stderr, /debugHost/);
});

// ------------------------------------------------------------------ two-step sign-in

const CHALLENGE = 'chl-secret-handle';
const CODE = '482915';
const verifyLogin = (method: 'totp' | 'email'): Reply => ({ status: 200, body: { success: true, status: 200, statusCode: 201, message: 'Verify', result: { challenge: CHALLENGE, method } } });
const checkCode = (body: Record<string, unknown>): Reply =>
    body.challenge === CHALLENGE && body.code === CODE ? PAIR : { status: 406, body: { success: false, status: 406, message: 'Not Acceptable' } };
const noSecrets = (text: string) => assert.ok(!/pw-secret|acc-secret|ref-secret|chl-secret|482915/.test(text), 'a secret or the code reached the output');

test('two-step sign-in: KEEN_MFA_CODE → verify { challenge, code } → the ticket and the attach as before; the code never printed', async () => {
    const srv = await fakeServer({ status: 200, body: '[]' }, DEFAULT_TICKET, { login: verifyLogin('totp'), verify: checkCode });
    try {
        const dir = await project({ server: srv.origin });
        const out = await runDebug(['--kind=flow', '--project', dir, '--json'], { KEEN_MFA_CODE: CODE });
        assert.equal(out.code, 0, out.stderr);
        assert.deepEqual(srv.calls.map(c => c.url), [
            '/keen-org-api/v1/auth/login',
            '/keen-org-api/v1/auth/login/verify',
            '/keen-org-api/v1/debug/ticket',
            '/keen-org-api/v1/auth/logout',
            `/keen-debug/flow/dbg/${TICKET}/json`
        ]);
        assert.deepEqual(JSON.parse(srv.calls[1].body), { challenge: CHALLENGE, code: CODE });
        const all = lines(out.stdout);
        assert.deepEqual(all.find(l => l.step === 'verify'), { t: 'meta', step: 'verify', method: 'totp' });
        assert.equal(all.find(l => l.t === 'attach')?.mode, 'edge');
        noSecrets(out.stdout + out.stderr);
    } finally {
        await srv.close();
    }
});

test('two-step sign-in: a refused code → exit 1 with the same words as a refused password, asked once, no ticket', async () => {
    const srv = await fakeServer({ status: 200, body: '[]' }, DEFAULT_TICKET, { login: verifyLogin('email'), verify: checkCode });
    try {
        const dir = await project({ server: srv.origin });
        const out = await runDebug(['--kind=flow', '--project', dir, '--json'], { KEEN_MFA_CODE: '000000' });
        assert.equal(out.code, 1);
        const failLine = lines(out.stdout).find(l => l.t === 'fail');
        assert.equal(failLine?.step, 'verify');
        assert.match(String(failLine?.reason), /^bad credentials — check "user" and "password"/);
        assert.deepEqual(srv.calls.map(c => c.url), ['/keen-org-api/v1/auth/login', '/keen-org-api/v1/auth/login/verify']);
        assert.ok(!/000000/.test(out.stdout + out.stderr));
    } finally {
        await srv.close();
    }
});

test('two-step sign-in without a terminal and without KEEN_MFA_CODE → exit 1, names both ways, no verify sent', async () => {
    const srv = await fakeServer({ status: 200, body: '[]' }, DEFAULT_TICKET, { login: verifyLogin('totp'), verify: checkCode });
    try {
        const dir = await project({ server: srv.origin });
        const out = await runDebug(['--kind=flow', '--project', dir, '--json']);
        assert.equal(out.code, 1);
        assert.match(String(lines(out.stdout).find(l => l.t === 'fail')?.reason), /terminal.*KEEN_MFA_CODE/);
        assert.deepEqual(srv.calls.map(c => c.url), ['/keen-org-api/v1/auth/login']);
    } finally {
        await srv.close();
    }
});

test('Enroll (the organization requires two-step sign-in, the account has none) → exit 1 "set it up in the console first", nothing else', async () => {
    const enroll: Reply = { status: 200, body: { success: true, status: 200, statusCode: 202, message: 'Enroll', result: { challenge: CHALLENGE, methods: ['totp', 'email'] } } };
    const srv = await fakeServer({ status: 200, body: '[]' }, DEFAULT_TICKET, { login: enroll });
    try {
        const dir = await project({ server: srv.origin });
        const out = await runDebug(['--kind=flow', '--project', dir, '--json'], { KEEN_MFA_CODE: CODE });
        assert.equal(out.code, 1);
        assert.match(String(lines(out.stdout).find(l => l.t === 'fail')?.reason), /set up two-step sign-in in the console first \(My Account › Security\)/);
        assert.deepEqual(srv.calls.map(c => c.url), ['/keen-org-api/v1/auth/login']);
        noSecrets(out.stdout + out.stderr);
    } finally {
        await srv.close();
    }
});

test('a KEEN_MFA_CODE that is not 6 digits → exit 2, nothing sent', async () => {
    const dir = await project({ server: 'https://keen.example.com' });
    const out = await runDebug(['--kind=flow', '--project', dir, '--json'], { KEEN_MFA_CODE: '12ab' });
    assert.equal(out.code, 2);
    assert.match(out.stderr, /KEEN_MFA_CODE must be the 6-digit code/);
});
