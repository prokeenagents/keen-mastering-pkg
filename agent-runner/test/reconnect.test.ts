/**
 * The Chat SDK's reconnect + resume (Keen 15.3), over a fake relay socket. `npm test`.
 *   a drop during a running flow → reconnect (full-jitter backoff, cap 10 s) → `resume` → `resumed` →
 *   the awaited frames re-sent with their ORIGINAL requestIds (the node-visit id) → the flow completes;
 *   every `resume-refused` reason, 4409, an old relay, the 15 s liveness close, the deferred cancel,
 *   disconnect() cancelling first, and E3002 on a continuation → one refresh → the same visit id.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';

import ChatAPI from '../sdk/index';
import { CHAT_SETTINGS } from '../sdk/settings';
import { CONNECTION_LOST_TEXT, reconnectDelayMs } from '../sdk/utils';

type Frame = { event: string; data: Record<string, any> };

/** A fake browser WebSocket: the SDK drives the client side, the test plays the relay. */
class FakeSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static all: FakeSocket[] = [];

    readyState = FakeSocket.CONNECTING;
    readonly sent: Frame[] = [];
    closedWith: { code: number; reason: string } | null = null;
    onopen: ((e: unknown) => void) | null = null;
    onclose: ((e: { code: number; reason: string }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;

    constructor(readonly url: string) {
        FakeSocket.all.push(this);
    }

    send(text: string): void {
        assert.equal(this.readyState, FakeSocket.OPEN, 'send on a socket that is not open');
        this.sent.push(JSON.parse(text));
    }

    /** The client closes (disconnect() / liveness / budget). */
    close(code = 1000, reason = ''): void {
        if (this.readyState === FakeSocket.CLOSED) {
            return;
        }
        this.closedWith = { code, reason };
        this.readyState = FakeSocket.CLOSED;
        this.onclose?.({ code, reason });
    }

    // ---- the relay side
    open(): void {
        this.readyState = FakeSocket.OPEN;
        this.onopen?.({});
    }

    push(event: string, data: Record<string, unknown>): void {
        this.onmessage?.({ data: JSON.stringify({ event, data }) });
    }

    /** The network drops the socket (the server sees 1006). */
    kill(code = 1006, reason = ''): void {
        this.readyState = FakeSocket.CLOSED;
        this.onclose?.({ code, reason });
    }

    runs(): Frame[] {
        return this.sent.filter(f => f.event === 'run');
    }

    of(event: string): Frame[] {
        return this.sent.filter(f => f.event === event);
    }
}

const last = (): FakeSocket => FakeSocket.all[FakeSocket.all.length - 1];

async function flush(): Promise<void> {
    for (let i = 0; i < 10; i++) {
        await new Promise(resolve => setImmediate(resolve));
    }
}

async function advance(ms: number, step = 250): Promise<void> {
    for (let t = 0; t < ms; t += step) {
        mock.timers.tick(Math.min(step, ms - t));
        await flush();
    }
}

const SPACE = { spaceID: 'space', agentID: 'agent', userId: 'user-1', email: 'u@example.com' };

function newChat(opts: { onAuthExpired?: () => Promise<string | null> } = {}): { chat: ChatAPI; system: string[]; statuses: string[] } {
    const chat = new ChatAPI({ url: 'wss://relay.test/ws-keen', accessToken: 'token-1', ...SPACE, ...opts } as never);
    const system: string[] = [];
    const statuses: string[] = [];

    chat.onSystem(text => system.push(text));
    chat.onStatus(status => statuses.push(status));
    return { chat, system, statuses };
}

function welcome(sock: FakeSocket, cid: string, extra: Record<string, unknown> = { resumeToken: `handle-${cid}`, graceMs: 120_000, protocol: 2 }): void {
    sock.open();
    sock.push('welcome', { correlationID: cid, ...extra });
}

const FC = (cid: string) => ({ flowId: 'f-root', correlationId: cid, sessionId: 's-root', requestId: 'r-root' });

function rootBundle(cid: string, nodeId = 'n1'): Record<string, unknown> {
    return {
        flowTask: {
            userContext: { userId: 'user-1', email: 'u@example.com' },
            rootFlowContext: FC(cid),
            rootAgentContext: { agentId: 'agent', prompt: 'hi' },
            chatContext: { chatId: 'chat', projectId: 'space' },
            flowContext: FC(cid)
        },
        nodeTasks: [{ flowContext: FC(cid), nodeContext: { id: nodeId, kind: 'scriptNode' } }]
    };
}

function ok(sock: FakeSocket, requestId: string, data: unknown): void {
    sock.push('run', { requestId, envelope: { success: true, code: 'E1001', message: 'OK', data } });
}

function fail(sock: FakeSocket, requestId: string, code: string, message: string): void {
    sock.push('run', { requestId, envelope: { success: false, code, message } });
}

const finalOf = (cid: string) => ({ final: true, flowContext: FC(cid) });
const nextNode = (cid: string, id: string) => ({ nodeTasks: [{ flowContext: FC(cid), nodeContext: { id, kind: 'scriptNode' } }] });

/** Start a flow on cid-1 and stop with node n1 dispatched and awaited. Returns the run promise and n1's visit id. */
async function startFlow(chat: ChatAPI) {
    chat.connect();
    const sock = last();
    welcome(sock, 'cid-1');
    await flush();

    const outcome: { value?: unknown; error?: Error } = {};
    const run = chat.runFlow({ chatId: 'chat', prompt: 'hi' });
    run.then(value => (outcome.value = value), error => (outcome.error = error));
    await flush();

    const start = sock.runs()[0];
    assert.ok(start, 'the run frame went out');
    ok(sock, start.data.requestId, rootBundle('cid-1'));
    await flush();

    const n1 = sock.runs()[1];
    assert.equal(n1?.data.payload.nodeContext.id, 'n1');
    return { sock, run, outcome, startId: start.data.requestId as string, n1Id: n1.data.requestId as string };
}

/** Drop the socket, let the backoff run out, open the next one with its own welcome. */
async function dropAndReconnect(sock: FakeSocket, opts: { code?: number; welcomeCid?: string; welcomeExtra?: Record<string, unknown> } = {}): Promise<FakeSocket> {
    const before = FakeSocket.all.length;
    sock.kill(opts.code ?? 1006);
    await advance(CHAT_SETTINGS.RECONNECT_MAX_MS);
    assert.equal(FakeSocket.all.length, before + 1, 'one new socket');
    const next = last();
    welcome(next, opts.welcomeCid ?? 'cid-2', opts.welcomeExtra);
    await flush();
    return next;
}

beforeEach(() => {
    FakeSocket.all = [];
    (globalThis as any).WebSocket = FakeSocket;
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
    mock.method(Math, 'random', () => 0.5);
});

afterEach(() => {
    mock.timers.reset();
    mock.restoreAll();
    delete (globalThis as any).window;
});

test('welcome → run → kill → reconnect → resume → resumed → the awaited frames are re-sent with their ORIGINAL requestIds, the flow completes', async () => {
    const { chat, system, statuses } = newChat();
    const resumes: Array<{ correlationID: string; detachedMs: number }> = [];
    chat.onResume(info => resumes.push(info));

    const { sock, outcome, n1Id } = await startFlow(chat);

    const sock2 = await dropAndReconnect(sock);
    assert.equal(chat.getStatus(), 'reconnecting');
    assert.ok(system.some(line => line === 'close (code 1006) — reconnecting in 0.5 s (attempt 1)'), system.join('\n'));

    // The first frame on the new socket is `resume`, for the OLD cid, with the old handle and the current token.
    assert.deepEqual(sock2.sent, [
        { event: 'resume', data: { correlationId: 'cid-1', resumeToken: 'handle-cid-1', userContext: { userId: 'user-1', accessToken: 'token-1' } } }
    ]);
    assert.equal(chat.isReady(), false);
    assert.equal(chat.getCorrelationID(), 'cid-1');

    sock2.push('resumed', { correlationID: 'cid-1', resumeToken: 'handle-rotated', graceMs: 120_000, detachedMs: 8421 });
    await flush();

    assert.equal(chat.getStatus(), 'connected');
    assert.equal(chat.isReady(), true);
    assert.deepEqual(resumes, [{ correlationID: 'cid-1', detachedMs: 8421 }]);
    assert.ok(system.includes('resumed — correlationID cid-1 after 8.4 s'));

    // n1 is re-sent with its ORIGINAL requestId and the current token.
    const resent = sock2.runs();
    assert.equal(resent.length, 1);
    assert.equal(resent[0].data.requestId, n1Id);
    assert.equal(resent[0].data.payload.nodeContext.id, 'n1');
    assert.equal(resent[0].data.payload.flowContext.correlationId, 'cid-1');

    ok(sock2, n1Id, nextNode('cid-1', 'n2'));
    await flush();
    const n2 = sock2.runs()[1];
    assert.equal(n2.data.payload.nodeContext.id, 'n2');
    ok(sock2, n2.data.requestId, finalOf('cid-1'));
    await flush();

    assert.equal(outcome.error, undefined);
    assert.ok(outcome.value instanceof Map);
    assert.deepEqual(statuses, ['connecting', 'connected', 'reconnecting', 'connected']);
    assert.equal(sock2.of('cancel').length, 0);

    // The next drop rotates to the handle the relay returned in `resumed`.
    chat.disconnect();
});

test('a frame sent between welcome and resumed is held until isReady()', async () => {
    const { chat } = newChat();
    const { sock, outcome, n1Id } = await startFlow(chat);

    // n1 answers, then the socket dies before n2 can go out: n2 waits in the transport retry.
    ok(sock, n1Id, nextNode('cid-1', 'n2'));
    sock.kill(1006);
    await flush();
    assert.equal(sock.runs().length, 2, 'nothing more went out on the dead socket');

    await advance(CHAT_SETTINGS.RECONNECT_MAX_MS);
    const sock2 = last();
    welcome(sock2, 'cid-2');
    await advance(3_000);

    // Open, welcomed, not resumed: only `resume` may be on the wire.
    assert.deepEqual(sock2.sent.map(f => f.event), ['resume']);

    sock2.push('resumed', { correlationID: 'cid-1', resumeToken: 'h2', graceMs: 120_000, detachedMs: 500 });
    await advance(1_000);

    const n2 = sock2.runs();
    assert.equal(n2.length, 1);
    assert.equal(n2[0].data.payload.nodeContext.id, 'n2');
    assert.equal(n2[0].data.payload.flowContext.correlationId, 'cid-1');

    ok(sock2, n2[0].data.requestId, finalOf('cid-1'));
    await flush();
    assert.ok(outcome.value instanceof Map);
    chat.disconnect();
});

test('resume-refused token + onAuthExpired: the hook is called once, the resume is re-sent with the new token', async () => {
    let calls = 0;
    const { chat, system } = newChat({ onAuthExpired: async () => (calls++, 'token-2') });
    const { sock, outcome, n1Id } = await startFlow(chat);
    const sock2 = await dropAndReconnect(sock);

    sock2.push('resume-refused', { correlationID: 'cid-1', reason: 'token', retry: true, envelope: { code: 'E3002', success: false, message: 'Invalid token' } });
    await flush();

    assert.equal(calls, 1);
    assert.ok(system.includes('resume refused (token) — waiting for a new access token'));
    const resumes = sock2.of('resume');
    assert.equal(resumes.length, 2);
    assert.equal(resumes[1].data.userContext.accessToken, 'token-2');
    assert.equal(resumes[1].data.resumeToken, 'handle-cid-1');

    sock2.push('resumed', { correlationID: 'cid-1', resumeToken: 'h2', graceMs: 120_000, detachedMs: 70_000 });
    await flush();
    const resent = sock2.runs()[0];
    assert.equal(resent.data.requestId, n1Id);
    assert.equal(resent.data.payload.userContext.accessToken, 'token-2');

    ok(sock2, n1Id, finalOf('cid-1'));
    await flush();
    assert.ok(outcome.value instanceof Map);
    chat.disconnect();
});

test('resume-refused token without the hook: it waits, and setAccessToken() re-sends the resume', async () => {
    const { chat } = newChat();
    const { sock, outcome, n1Id } = await startFlow(chat);
    const sock2 = await dropAndReconnect(sock);

    sock2.push('resume-refused', { correlationID: 'cid-1', reason: 'token', retry: true, envelope: { code: 'E3002', success: false, message: 'Invalid token' } });
    await advance(30_000);
    assert.equal(sock2.of('resume').length, 1, 'no re-resume with the same token');
    assert.equal(sock2.closedWith, null, 'the socket stays open (no liveness close while waiting for a token)');

    chat.setAccessToken('token-1');
    await flush();
    assert.equal(sock2.of('resume').length, 1, 'an unchanged token does not re-resume');

    chat.setAccessToken('token-2');
    await flush();
    const resumes = sock2.of('resume');
    assert.equal(resumes.length, 2);
    assert.equal(resumes[1].data.userContext.accessToken, 'token-2');

    sock2.push('resumed', { correlationID: 'cid-1', resumeToken: 'h2', graceMs: 120_000, detachedMs: 35_000 });
    await flush();
    ok(sock2, n1Id, finalOf('cid-1'));
    await flush();
    assert.ok(outcome.value instanceof Map);
    chat.disconnect();
});

test('resume-refused token, the hook answers null: the run rejects `Invalid token`, no cancel, the socket moves to its own cid', async () => {
    const { chat } = newChat({ onAuthExpired: async () => null });
    const { sock, outcome } = await startFlow(chat);
    const sock2 = await dropAndReconnect(sock);

    sock2.push('resume-refused', { correlationID: 'cid-1', reason: 'token', retry: true, envelope: { code: 'E3002', success: false, message: 'Invalid token' } });
    await flush();

    assert.equal(outcome.error?.message, CONNECTION_LOST_TEXT.INVALID_TOKEN);
    assert.equal(sock2.of('cancel').length, 0);
    assert.equal(chat.getCorrelationID(), 'cid-2');
    assert.equal(chat.isReady(), true);
    chat.disconnect();
});

test('resume-refused unavailable: the resume is re-sent after the backoff, on the same socket', async () => {
    const { chat, system } = newChat();
    const { sock, outcome, n1Id } = await startFlow(chat);
    const sock2 = await dropAndReconnect(sock);
    const sockets = FakeSocket.all.length;

    sock2.push('resume-refused', { correlationID: 'cid-1', reason: 'unavailable', retry: true, envelope: { code: 'E7002', success: false, message: 'revocation list unavailable' } });
    await flush();
    assert.ok(system.includes('resume refused (unavailable) — retrying in 0.5 s'));
    assert.equal(sock2.of('resume').length, 1);

    await advance(500);
    assert.equal(sock2.of('resume').length, 2);
    assert.equal(FakeSocket.all.length, sockets, 'no new socket');

    sock2.push('resumed', { correlationID: 'cid-1', resumeToken: 'h2', graceMs: 120_000, detachedMs: 2_000 });
    await flush();
    ok(sock2, n1Id, finalOf('cid-1'));
    await flush();
    assert.ok(outcome.value instanceof Map);
    chat.disconnect();
});

test('resume-refused gone: the flow fails with the gone text, no cancel, the socket moves to its own cid', async () => {
    const { chat, system } = newChat();
    const { sock, outcome } = await startFlow(chat);
    const sock2 = await dropAndReconnect(sock);

    sock2.push('resume-refused', { correlationID: 'cid-1', reason: 'gone', retry: false, envelope: { code: 'E5201', success: false, message: 'the flow is no longer held' } });
    await flush();

    assert.equal(outcome.error?.message, CONNECTION_LOST_TEXT.GONE);
    assert.ok(system.includes('resume refused (gone) — the server no longer holds this flow'));
    assert.equal(sock2.of('cancel').length, 0);
    assert.equal(sock2.runs().length, 0);
    assert.equal(chat.getCorrelationID(), 'cid-2');
    assert.equal(chat.isRunning(), false);

    // The next turn runs on the new cid.
    const next = chat.runFlow({ chatId: 'chat', prompt: 'again' });
    await flush();
    const start = sock2.runs()[0];
    assert.equal(start.data.payload.flowContext.correlationId, 'cid-2');
    ok(sock2, start.data.requestId, {});
    await next;
    chat.disconnect();
});

test('resume-refused protocol: the flow fails (E2001), no cancel', async () => {
    const { chat } = newChat();
    const { sock, outcome } = await startFlow(chat);
    const sock2 = await dropAndReconnect(sock);

    sock2.push('resume-refused', { correlationID: 'cid-1', reason: 'protocol', retry: false, envelope: { code: 'E2001', success: false, message: 'resume must be the first frame on a connection' } });
    await flush();

    assert.equal(outcome.error?.message, CONNECTION_LOST_TEXT.GONE);
    assert.equal((outcome.error as { code?: string }).code, 'E2001');
    assert.equal(sock2.of('cancel').length, 0);
    chat.disconnect();
});

test('resume-refused gone while only the run frame was sent and no reply came: the start is re-sent on the NEW cid', async () => {
    const { chat } = newChat();
    chat.connect();
    const sock = last();
    welcome(sock, 'cid-1');
    await flush();

    const run = chat.runFlow({ chatId: 'chat', prompt: 'hi' });
    await flush();
    const first = sock.runs()[0];

    const sock2 = await dropAndReconnect(sock);
    assert.equal(sock2.of('resume').length, 1);
    sock2.push('resume-refused', { correlationID: 'cid-1', reason: 'gone', retry: false, envelope: { code: 'E5201', success: false, message: 'the flow is no longer held' } });
    await advance(CHAT_SETTINGS.RETRY_DELAY_MS + 1_000);

    const restart = sock2.runs();
    assert.equal(restart.length, 1);
    assert.equal(restart[0].data.payload.flowContext.correlationId, 'cid-2');
    assert.notEqual(restart[0].data.requestId, first.data.requestId);

    ok(sock2, restart[0].data.requestId, rootBundle('cid-2'));
    await flush();
    const n1 = sock2.runs()[1];
    ok(sock2, n1.data.requestId, finalOf('cid-2'));
    assert.ok((await run) instanceof Map);
    chat.disconnect();
});

test('close 4409 (superseded): the flow fails with the takeover text, no cancel, no reconnect', async () => {
    const { chat } = newChat();
    const { sock, outcome } = await startFlow(chat);

    sock.kill(4409, 'superseded');
    await advance(30_000);

    assert.equal(outcome.error?.message, CONNECTION_LOST_TEXT.SUPERSEDED);
    assert.equal(FakeSocket.all.length, 1, 'no reconnect');
    assert.equal(chat.getStatus(), 'disconnected');
    assert.equal(sock.of('cancel').length, 0);
});

test('an old relay (welcome without protocol): a drop fails the flow at once with the §6.5 text; the socket still reconnects for the next turn', async () => {
    const { chat } = newChat();
    chat.connect();
    const sock = last();
    welcome(sock, 'cid-1', {});
    await flush();

    const outcome: { error?: Error } = {};
    chat.runFlow({ chatId: 'chat', prompt: 'hi' }).catch(error => (outcome.error = error));
    await flush();
    ok(sock, sock.runs()[0].data.requestId, rootBundle('cid-1'));
    await flush();

    sock.kill(1006);
    await flush();
    assert.equal(outcome.error?.message, CONNECTION_LOST_TEXT.OLD_RELAY);

    await advance(CHAT_SETTINGS.RECONNECT_MAX_MS);
    const sock2 = last();
    assert.notEqual(sock2, sock);
    welcome(sock2, 'cid-2', {});
    await flush();
    assert.deepEqual(sock2.sent, [], 'no resume to an old relay');
    assert.equal(chat.getCorrelationID(), 'cid-2');
    assert.equal(chat.getStatus(), 'connected');
    chat.disconnect();
});

test('liveness: 15 s of silence while a run is active closes the socket with 4000 and reconnects; pongs keep it open', async () => {
    const { chat } = newChat();
    const { sock, outcome, n1Id } = await startFlow(chat);

    // The relay answers every ping: 30 s with no reply to n1, the socket stays.
    const pongs = setInterval(() => {
        for (const _ of sock.of('ping').slice(answered)) {
            answered += 1;
            sock.push('pong', {});
        }
    }, 1_000);
    let answered = 0;
    await advance(30_000);
    clearInterval(pongs);
    assert.equal(sock.closedWith, null);
    assert.ok(sock.of('ping').length >= 5);
    assert.deepEqual(sock.of('ping')[0].data, { protocol: 2 });

    // Silence: closed with 4000 within 15 s (+ the 1 s check).
    await advance(CHAT_SETTINGS.LIVENESS_MS + 1_000);
    assert.equal(sock.closedWith?.code, 4000);
    assert.equal(chat.getStatus(), 'reconnecting');

    await advance(CHAT_SETTINGS.RECONNECT_MAX_MS);
    const sock2 = last();
    welcome(sock2, 'cid-2');
    await flush();
    sock2.push('resumed', { correlationID: 'cid-1', resumeToken: 'h2', graceMs: 120_000, detachedMs: 1_000 });
    await flush();
    assert.equal(sock2.runs()[0].data.requestId, n1Id);
    ok(sock2, n1Id, finalOf('cid-1'));
    await flush();
    assert.ok(outcome.value instanceof Map);
    chat.disconnect();
});

test('no liveness close while no run is active', async () => {
    const { chat } = newChat();
    chat.connect();
    const sock = last();
    welcome(sock, 'cid-1');
    await advance(60_000);
    assert.equal(sock.closedWith, null);
    chat.disconnect();
});

test('the deferred cancel: cancel() while reconnecting rejects at once; the next socket resumes, then sends the cancel', async () => {
    const { chat } = newChat();
    const { sock, outcome } = await startFlow(chat);

    sock.kill(1006);
    await flush();
    chat.cancel();
    await flush();
    assert.equal(outcome.error?.message, 'TaskQueue cancelled');
    assert.equal(chat.isRunning(), false);

    await advance(CHAT_SETTINGS.RECONNECT_MAX_MS);
    const sock2 = last();
    welcome(sock2, 'cid-2');
    await flush();
    assert.deepEqual(sock2.sent.map(f => f.event), ['resume']);

    sock2.push('resumed', { correlationID: 'cid-1', resumeToken: 'h2', graceMs: 120_000, detachedMs: 3_000 });
    await advance(3_000);

    assert.deepEqual(sock2.sent.map(f => f.event).filter(e => e !== 'ping'), ['resume', 'cancel']);
    assert.deepEqual(sock2.of('cancel')[0].data, { correlationId: 'cid-1' });
    assert.equal(sock2.runs().length, 0, 'the cancelled flow re-sends nothing');
    chat.disconnect();
});

test('disconnect() cancels a running flow first, then closes 1000 with no reconnect', async () => {
    const { chat } = newChat();
    const { sock, outcome } = await startFlow(chat);

    chat.disconnect();
    await flush();

    const events = sock.sent.map(f => f.event);
    assert.equal(events[events.length - 1], 'cancel');
    assert.deepEqual(sock.of('cancel')[0].data, { correlationId: 'cid-1' });
    assert.equal(sock.closedWith?.code, 1000);
    assert.ok(outcome.error);

    await advance(30_000);
    assert.equal(FakeSocket.all.length, 1);
    assert.equal(chat.getStatus(), 'disconnected');
});

test('pagehide (not persisted) cancels a running flow; a bfcache pagehide does not', async () => {
    const listeners: Record<string, (e: unknown) => void> = {};
    (globalThis as any).window = {
        addEventListener: (type: string, fn: (e: unknown) => void) => (listeners[type] = fn),
        removeEventListener: (type: string) => delete listeners[type]
    };
    const { chat } = newChat();
    const { sock, outcome } = await startFlow(chat);

    listeners.pagehide({ persisted: true });
    await flush();
    assert.equal(sock.of('cancel').length, 0);

    listeners.pagehide({ persisted: false });
    await flush();
    assert.equal(sock.of('cancel').length, 1);
    assert.equal(outcome.error?.message, 'TaskQueue cancelled');
    chat.disconnect();
    assert.equal(listeners.pagehide, undefined);
});

test('the reconnect backoff: full jitter, caps 1 → 2 → 4 → 8 → 10 s, then 10 s for ever; 1012 waits 0–1 s', async () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 40].map(n => reconnectDelayMs(n, () => 0.999999)), [999, 1_999, 3_999, 7_999, 9_999, 9_999, 9_999]);
    assert.equal(reconnectDelayMs(5, () => 0), 0);

    const { chat, system } = newChat();
    chat.connect();
    welcome(last(), 'cid-1');
    await flush();

    // A relay that is down: every new socket dies before its welcome. The attempt count keeps growing.
    last().kill(1006);
    for (let i = 0; i < 6; i++) {
        await advance(CHAT_SETTINGS.RECONNECT_MAX_MS);
        last().kill(1006);
    }
    await flush();
    const delays = system
        .filter(line => line.includes('reconnecting in'))
        .map(line => Number(/reconnecting in ([\d.]+) s \(attempt (\d+)\)/.exec(line)?.[1]));
    // Math.random = 0.5: half of each cap.
    assert.deepEqual(delays, [0.5, 1, 2, 4, 5, 5, 5]);

    // A relay restart (1012) reconnects within 0–1 s whatever the attempt.
    await advance(CHAT_SETTINGS.RECONNECT_MAX_MS);
    last().kill(1012);
    await flush();
    assert.match(system[system.length - 1], /^close \(code 1012\) — reconnecting in 0\.5 s \(attempt 8\)$/);

    // A welcome resets the count.
    await advance(1_000);
    welcome(last(), 'cid-9');
    await flush();
    last().kill(1006);
    await flush();
    assert.match(system[system.length - 1], /\(attempt 1\)$/);
    chat.disconnect();
});

test('a close before the first welcome stays disconnected (fail fast, no reconnect)', async () => {
    const { chat } = newChat();
    chat.connect();
    last().kill(1006);
    await advance(30_000);
    assert.equal(FakeSocket.all.length, 1);
    assert.equal(chat.getStatus(), 'disconnected');
});

test('E3002 on a continuation → one refresh through onAuthExpired → a retry of the SAME visit id', async () => {
    let calls = 0;
    const { chat } = newChat({ onAuthExpired: async () => (calls++, 'token-2') });
    const { sock, outcome, n1Id } = await startFlow(chat);

    fail(sock, n1Id, 'E3002', 'Invalid token');
    await flush();
    assert.equal(calls, 1);
    const retry = sock.runs()[2];
    assert.equal(retry.data.requestId, n1Id);
    assert.equal(retry.data.payload.userContext.accessToken, 'token-2');

    ok(sock, n1Id, finalOf('cid-1'));
    await flush();
    assert.ok(outcome.value instanceof Map);
    chat.disconnect();
});

test('E3002 again after the refresh is terminal; a null refresh is terminal (`Invalid token`)', async () => {
    {
        const { chat } = newChat({ onAuthExpired: async () => 'token-2' });
        const { sock, outcome, n1Id } = await startFlow(chat);
        fail(sock, n1Id, 'E3002', 'Invalid token');
        await flush();
        fail(sock, n1Id, 'E3002', 'Invalid token');
        await flush();
        assert.equal(outcome.error?.message, 'Invalid token');
        chat.disconnect();
    }
    {
        const { chat } = newChat({ onAuthExpired: async () => null });
        const { sock, outcome, n1Id } = await startFlow(chat);
        fail(sock, n1Id, 'E3002', 'Invalid token');
        await flush();
        assert.equal(outcome.error?.message, CONNECTION_LOST_TEXT.INVALID_TOKEN);
        assert.equal(sock.runs().length, 2, 'no retry');
        chat.disconnect();
    }
});

test('every retry of a node keeps its visit id (E4 / E7 refusals)', async () => {
    const { chat } = newChat();
    const { sock, outcome, n1Id } = await startFlow(chat);

    fail(sock, n1Id, 'E4001', 'Engine refused at admission — retry');
    await advance(CHAT_SETTINGS.RETRY_MAX_DELAY_MS);
    fail(sock, n1Id, 'E7002', 'transport');
    await advance(CHAT_SETTINGS.RETRY_MAX_DELAY_MS);

    const ids = sock.runs().slice(1).map(f => f.data.requestId);
    assert.equal(ids.length, 3);
    assert.ok(ids.every(id => id === n1Id));

    ok(sock, n1Id, finalOf('cid-1'));
    await flush();
    assert.ok(outcome.value instanceof Map);
    chat.disconnect();
});

test('the resume token never appears in a system message', async () => {
    const { chat, system } = newChat();
    const { sock } = await startFlow(chat);
    const sock2 = await dropAndReconnect(sock);
    sock2.push('resumed', { correlationID: 'cid-1', resumeToken: 'handle-rotated', graceMs: 120_000, detachedMs: 10 });
    await flush();
    assert.ok(system.every(line => !line.includes('handle-')), system.join('\n'));
    chat.disconnect();
});

test('the run frame keeps ONE requestId across its E4 re-sends', async () => {
    const { chat } = newChat();
    chat.connect();
    const sock = last();
    welcome(sock, 'cid-1');
    await flush();

    const run = chat.runFlow({ chatId: 'chat', prompt: 'hi' });
    await flush();
    const id = sock.runs()[0].data.requestId;
    fail(sock, id, 'E4001', 'Engine refused at admission — retry');
    await advance(CHAT_SETTINGS.RETRY_DELAY_MS + 500);
    assert.equal(sock.runs().length, 2);
    assert.equal(sock.runs()[1].data.requestId, id);

    ok(sock, id, {});
    assert.ok((await run) instanceof Map);
    chat.disconnect();
});

test('a drop before the run frame went out: the start follows the new cid (nothing to resume)', async () => {
    const { chat } = newChat();
    chat.connect();
    const sock = last();
    welcome(sock, 'cid-1');
    await flush();

    sock.kill(1006);
    await flush();
    const run = chat.runFlow({ chatId: 'chat', prompt: 'hi' });
    await flush();

    // The reconnect (0.5 s) comes well inside the run frame's 10 × 1 s transport retries.
    await advance(1_000);
    const sock2 = last();
    assert.notEqual(sock2, sock);
    sock2.open();
    await advance(2_000);
    assert.deepEqual(sock2.sent, [], 'nothing before the welcome');
    sock2.push('welcome', { correlationID: 'cid-2', resumeToken: 'h', graceMs: 120_000, protocol: 2 });
    await advance(1_000);

    assert.deepEqual(sock2.sent.map(f => f.event).filter(e => e !== 'ping'), ['run']);
    const start = sock2.runs()[0];
    assert.equal(start.data.payload.flowContext.correlationId, 'cid-2');
    ok(sock2, start.data.requestId, {});
    assert.ok((await run) instanceof Map);
    chat.disconnect();
});

test('welcome.limits.promptChars is exposed by getPromptLimit() (null without it, kept across a reconnect)', async () => {
    const { chat } = newChat();
    chat.connect();
    const sock = last();
    welcome(sock, 'cid-1', { resumeToken: 'h1', graceMs: 120_000, protocol: 2, limits: { promptChars: 20_000 } });
    await flush();
    assert.equal(chat.getPromptLimit(), 20_000);

    const sock2 = await dropAndReconnect(sock, { welcomeExtra: { resumeToken: 'h2', graceMs: 120_000, protocol: 2 } });
    assert.equal(chat.getPromptLimit(), null, 'a welcome without limits clears it');
    sock2.kill(1006);
    chat.disconnect();
});

test('a malformed limits value is ignored', async () => {
    const { chat } = newChat();
    chat.connect();
    welcome(last(), 'cid-1', { protocol: 2, limits: { promptChars: 'lots' } });
    await flush();
    assert.equal(chat.getPromptLimit(), null);
    chat.disconnect();
});
