/**
 * ChatAPI.onSummarizing(handler) — `true` when the TaskQueue dispatches a node task of kind `summarizerNode`
 * (the chat-memory step, §14.6), `false` when that task settles (its reply, an error, a cancel, the flow's end).
 * Over the same fake relay socket as reconnect.test.ts. `npm test`.
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
const nextNode = (cid: string, id: string, kind = 'scriptNode') => ({ nodeTasks: [{ flowContext: FC(cid), nodeContext: { id, kind } }] });

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


/** Record every onSummarizing / onRunning transition in one ordered log. */
function watch(chat: ChatAPI): string[] {
    const log: string[] = [];

    chat.onSummarizing(active => log.push(`summarizing:${active}`));
    chat.onRunning(running => log.push(`running:${running}`));
    return log;
}

test('onSummarizing: true when the summarizerNode task is dispatched, false when it replies; the flow stays running meanwhile', async () => {
    const { chat } = newChat();
    const log = watch(chat);
    const { sock, outcome, n1Id } = await startFlow(chat);

    // The LLM node exits via Summary: the next node is the Summarizer.
    ok(sock, n1Id, nextNode('cid-1', 'sum1', 'summarizerNode'));
    await flush();

    assert.equal(sock.runs()[2].data.payload.nodeContext.kind, 'summarizerNode');
    assert.deepEqual(log, ['running:true', 'summarizing:true']);
    assert.equal(chat.isRunning(), true);

    // The Summarizer exits via Out to the End node.
    ok(sock, sock.runs()[2].data.requestId, nextNode('cid-1', 'end1'));
    await flush();
    assert.deepEqual(log, ['running:true', 'summarizing:true', 'summarizing:false'], 'false at the reply, before the flow ends');
    assert.equal(chat.isRunning(), true);

    ok(sock, sock.runs()[3].data.requestId, finalOf('cid-1'));
    await flush();
    assert.ok(outcome.value instanceof Map);
    assert.deepEqual(log, ['running:true', 'summarizing:true', 'summarizing:false', 'running:false']);
    chat.disconnect();
});

test('onSummarizing never fires for other node kinds', async () => {
    const { chat } = newChat();
    const log = watch(chat);
    const { sock, outcome, n1Id } = await startFlow(chat);

    ok(sock, n1Id, nextNode('cid-1', 'n2', 'agentNode'));
    await flush();
    ok(sock, sock.runs()[2].data.requestId, finalOf('cid-1'));
    await flush();

    assert.ok(outcome.value instanceof Map);
    assert.deepEqual(log, ['running:true', 'running:false']);
    chat.disconnect();
});

test('onSummarizing: a Summarizer that ends the flow (final) settles it false once, before running:false', async () => {
    const { chat } = newChat();
    const log = watch(chat);
    const { sock, outcome, n1Id } = await startFlow(chat);

    ok(sock, n1Id, nextNode('cid-1', 'sum1', 'summarizerNode'));
    await flush();
    ok(sock, sock.runs()[2].data.requestId, finalOf('cid-1'));
    await flush();

    assert.ok(outcome.value instanceof Map);
    assert.deepEqual(log, ['running:true', 'summarizing:true', 'summarizing:false', 'running:false']);
    chat.disconnect();
});

test('onSummarizing: a Fallback chain of Summarizers goes true, false, true, false', async () => {
    const { chat } = newChat();
    const log = watch(chat);
    const { sock, outcome, n1Id } = await startFlow(chat);

    ok(sock, n1Id, nextNode('cid-1', 'sum1', 'summarizerNode'));
    await flush();
    ok(sock, sock.runs()[2].data.requestId, nextNode('cid-1', 'sum2', 'summarizerNode'));
    await flush();
    ok(sock, sock.runs()[3].data.requestId, finalOf('cid-1'));
    await flush();

    assert.ok(outcome.value instanceof Map);
    assert.deepEqual(log.filter(l => l.startsWith('summarizing')), ['summarizing:true', 'summarizing:false', 'summarizing:true', 'summarizing:false']);
    chat.disconnect();
});

test('onSummarizing: a terminal error on the Summarizer task settles false and the run rejects', async () => {
    const { chat } = newChat();
    const log = watch(chat);
    const { sock, outcome, n1Id } = await startFlow(chat);

    ok(sock, n1Id, nextNode('cid-1', 'sum1', 'summarizerNode'));
    await flush();
    fail(sock, sock.runs()[2].data.requestId, 'E3101', 'Invalid input');
    await flush();

    assert.ok(outcome.error, 'the run rejected');
    assert.deepEqual(log, ['running:true', 'summarizing:true', 'summarizing:false', 'running:false']);
    chat.disconnect();
});

test('onSummarizing: cancel() while summarizing settles false (never stuck at true)', async () => {
    const { chat } = newChat();
    const log = watch(chat);
    const { sock, outcome, n1Id } = await startFlow(chat);

    ok(sock, n1Id, nextNode('cid-1', 'sum1', 'summarizerNode'));
    await flush();
    assert.deepEqual(log, ['running:true', 'summarizing:true']);

    chat.cancel();
    await flush();

    assert.ok(outcome.error);
    assert.deepEqual(log, ['running:true', 'summarizing:true', 'summarizing:false', 'running:false']);
    chat.disconnect();
});

test('onSummarizing: disconnect() while summarizing settles false', async () => {
    const { chat } = newChat();
    const log = watch(chat);
    const { sock, n1Id } = await startFlow(chat);

    ok(sock, n1Id, nextNode('cid-1', 'sum1', 'summarizerNode'));
    await flush();
    chat.disconnect();
    await flush();

    assert.equal(log.filter(l => l === 'summarizing:true').length, 1);
    assert.equal(log[log.length - 2], 'summarizing:false');
    assert.equal(log[log.length - 1], 'running:false');
});

test('onSummarizing: the unsubscribe function stops the handler', async () => {
    const { chat } = newChat();
    const seen: boolean[] = [];
    const off = chat.onSummarizing(active => seen.push(active));
    const { sock, n1Id } = await startFlow(chat);

    ok(sock, n1Id, nextNode('cid-1', 'sum1', 'summarizerNode'));
    await flush();
    assert.deepEqual(seen, [true]);

    off();
    ok(sock, sock.runs()[2].data.requestId, finalOf('cid-1'));
    await flush();
    assert.deepEqual(seen, [true], 'no false after the unsubscribe');
    chat.disconnect();
});
