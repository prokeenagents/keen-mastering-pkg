/**
 * The Chat SDK's retries (Keen 15.3). `npm test` (node --test through tsx).
 *   the run frame (first prompt) — the only thing that may be refused: an E4 refusal retried 10 × 1 s, then it settles;
 *   every node (startNode and every `initial: true` node included) — unlimited, full jitter in
 *   [0, min(10 s, 1 s × 2^(n−1))], a `retryAfterMs` hint capped at 10 s, reset per node.
 */
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { CHAT_SETTINGS } from '../sdk/settings';
import TaskQueue from '../sdk/task-queue';
import { retryAfterHintMs, retryBackoffMs } from '../sdk/utils';

const BASE = { baseMs: CHAT_SETTINGS.RETRY_BASE_DELAY_MS, maxMs: CHAT_SETTINGS.RETRY_MAX_DELAY_MS };

test('the schedule: caps of 1 → 2 → 4 → 8 → 10 s, then 10 s for ever', () => {
    const top = (n: number) => retryBackoffMs(n, { ...BASE, random: () => 0.999999 });

    assert.deepEqual([1, 2, 3, 4, 5, 6, 50, 5_000].map(top), [999, 1_999, 3_999, 7_999, 9_999, 9_999, 9_999, 9_999]);
    assert.equal(CHAT_SETTINGS.RETRY_MAX_DELAY_MS, 10_000);
});

test('full jitter: every pause lies in [0, cap], down to 0', () => {
    assert.equal(retryBackoffMs(4, { ...BASE, random: () => 0 }), 0);
    assert.equal(retryBackoffMs(4, { ...BASE, random: () => 0.5 }), 4_000);

    for (let i = 0; i < 2_000; i++) {
        const n = 1 + (i % 15);
        const cap = Math.min(10_000, 1_000 * 2 ** (n - 1));
        const ms = retryBackoffMs(n, BASE);

        assert.ok(ms >= 0 && ms <= cap, `failure ${n}: ${ms} ms outside [0, ${cap}]`);
    }
});

test('a retryAfterMs hint on an E4 refusal wins, capped at 10 s; other codes carry no hint', () => {
    assert.equal(retryAfterHintMs({ code: 'E4001', success: false, retryAfterMs: 2_500 }), 2_500);
    assert.equal(retryAfterHintMs({ code: 'E4001', success: false, details: { retryAfterMs: 700 } }), 700);
    assert.equal(retryAfterHintMs({ code: 'E7002', success: false, retryAfterMs: 2_500 }), null);
    assert.equal(retryAfterHintMs({ code: 'E4001', success: false }), null);
    assert.equal(retryAfterHintMs({ code: 'E4001', success: false, retryAfterMs: -1 }), null);
    assert.equal(retryAfterHintMs(null), null);

    assert.equal(retryBackoffMs(1, { ...BASE, hintMs: 2_500 }), 2_500);
    assert.equal(retryBackoffMs(1, { ...BASE, hintMs: 60_000 }), 10_000);
});

/** A TaskQueue over a fake ChatAPI: each node answers the queued envelopes in order. */
function harness(replies: Record<string, Array<Record<string, unknown>>>) {
    let next = 0;
    const byRequest = new Map<string, Record<string, unknown>>();
    const chat = {
        accessToken: 'token',
        sendNodeTask: async (payload: { nodeContext: { id: string } }) => {
            const requestId = `req-${next++}`;
            const envelope = replies[payload.nodeContext.id].shift();
            assert.ok(envelope, `no reply left for ${payload.nodeContext.id}`);
            byRequest.set(requestId, envelope);
            return requestId;
        },
        waitFor: async (requestId: string) => byRequest.get(requestId)
    };
    const queue = new TaskQueue(chat as never);
    const pauses: Array<{ node: string; failures: number; ms: number }> = [];
    const original = (queue as unknown as { retryDelayMs: (f: number, e: unknown) => number }).retryDelayMs.bind(queue);
    let current = '';

    (queue as unknown as { retryDelayMs: (f: number, e: unknown) => number }).retryDelayMs = (failures, envelope) => {
        pauses.push({ node: current, failures, ms: original(failures, envelope) });
        return 0;
    };

    const bundle = {
        flowTask: {
            userContext: { userId: 'u', email: '' },
            rootFlowContext: { flowId: 'f-root', correlationId: 'cid', sessionId: 's', requestId: 'r' },
            chatContext: { chatId: 'c', projectId: 'p' },
            flowContext: { flowId: 'f-root', correlationId: 'cid', sessionId: 's', requestId: 'r', completed: false }
        },
        nodeTasks: [] as unknown[]
    };

    const run = async (id: string, initial: boolean, kind = 'scriptNode') => {
        current = id;
        const node = { flowContext: {}, nodeContext: { id, kind, initial }, ready: false, inProgress: true };
        bundle.nodeTasks.push(node);
        await (queue as unknown as { runRegularNode: (b: unknown, n: unknown) => Promise<void> }).runRegularNode(bundle, node);
        return node;
    };

    return { run, pauses };
}

const REFUSED = { success: false, code: 'E4001', message: 'Engine refused at admission — retry' };
const OK = { success: true, code: 'E1001', data: { nodeTasks: [] } };

test('a continuation backs off per failure in a row and starts over after a success', async () => {
    const { run, pauses } = harness({
        a: [REFUSED, REFUSED, REFUSED, OK],
        b: [REFUSED, { success: false, code: 'E7002', message: 'transport' }, OK]
    });

    assert.equal((await run('a', false)).ready, true);
    assert.equal((await run('b', false)).ready, true);

    assert.deepEqual(
        pauses.map(p => `${p.node}:${p.failures}`),
        ['a:1', 'a:2', 'a:3', 'b:1', 'b:2']
    );
    for (const p of pauses) {
        assert.ok(p.ms >= 0 && p.ms <= Math.min(10_000, 1_000 * 2 ** (p.failures - 1)));
    }
});

test('a continuation retries without a limit (well past the initial 10)', async () => {
    const { run, pauses } = harness({ c: [...Array.from({ length: 25 }, () => REFUSED), OK] });

    assert.equal((await run('c', false)).ready, true);
    assert.equal(pauses.length, 25);
    assert.ok(pauses.slice(5).every(p => p.ms <= 10_000));
});

test('the root flow\'s startNode (initial: true) refused 15 times is still retried and completes', async () => {
    const { run, pauses } = harness({ start: [...Array.from({ length: 15 }, () => REFUSED), OK] });

    const node = await run('start', true, 'startNode');

    assert.equal(node.ready, true);
    assert.equal(pauses.length, 15);
    assert.deepEqual(pauses.slice(0, 5).map(p => p.failures), [1, 2, 3, 4, 5]);
    assert.ok(pauses.every(p => p.ms >= 0 && p.ms <= 10_000));
});

test('an initial node of a child flow / clone / jump uses the same unlimited backoff', async () => {
    const { run, pauses } = harness({ child: [...Array.from({ length: 12 }, () => ({ success: false, code: 'E7002', message: 'transport' })), OK] });

    assert.equal((await run('child', true)).ready, true);
    assert.equal(pauses.length, 12);
});

test('E2 / E3 / E8 on a node stay terminal', async () => {
    for (const code of ['E2003', 'E3002', 'E8001']) {
        const { run, pauses } = harness({ [code]: [{ success: false, code, message: `terminal ${code}` }] });

        await assert.rejects(run(code, true), new RegExp(`terminal ${code}`));
        assert.equal(pauses.length, 0);
    }
});

/** The run frame (the first prompt) over a fake ChatAPI that answers `replies` in order. */
function runFrameHarness(replies: Array<Record<string, unknown>>) {
    let sends = 0;
    const chat = {
        send: async () => `run-${sends++}`,
        waitFor: async () => {
            const envelope = replies.shift();
            assert.ok(envelope, 'no reply left for the run frame');
            return envelope;
        }
    };
    const queue = new TaskQueue(chat as never);
    const sendRunFrame = (queue as unknown as { sendRunFrame: (p: unknown) => Promise<{ success: boolean }> }).sendRunFrame.bind(queue);

    return { sendRunFrame: () => sendRunFrame({ rootAgentContext: { agentId: 'a', prompt: 'hi' } }), sends: () => sends };
}

/** Drive a promise that sleeps on setTimeout under mock timers: flush, tick 1 s, until it settles. */
async function drive<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown; ticks: number }> {
    let settled: { value?: T; error?: unknown } | null = null;
    promise.then(value => (settled = { value }), error => (settled = { error }));
    let ticks = 0;

    while (!settled && ticks < 100) {
        await new Promise(resolve => setImmediate(resolve));
        if (!settled) {
            mock.timers.tick(CHAT_SETTINGS.RETRY_DELAY_MS);
            ticks++;
        }
    }

    return { ...(settled ?? {}), ticks };
}

test('the run frame: an E4 refusal is retried 10 × 1 s, then settles with the refusal ("busy")', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
        const { sendRunFrame, sends } = runFrameHarness(Array.from({ length: 12 }, () => REFUSED));

        const result = await drive(sendRunFrame());

        assert.match(String((result.error as Error)?.message), /Engine refused at admission/);
        assert.equal(sends(), CHAT_SETTINGS.INITIAL_MAX_RETRIES);
        assert.equal(result.ticks, CHAT_SETTINGS.INITIAL_MAX_RETRIES - 1);
    } finally {
        mock.timers.reset();
    }
});

test('the run frame: accepted on the 4th attempt → the flow starts', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
        const { sendRunFrame, sends } = runFrameHarness([REFUSED, REFUSED, REFUSED, OK]);

        const result = await drive(sendRunFrame());

        assert.deepEqual(result.value, OK);
        assert.equal(sends(), 4);
    } finally {
        mock.timers.reset();
    }
});

test('the run frame: a non-E4 failure is not retried (terminal, as before)', async () => {
    const { sendRunFrame, sends } = runFrameHarness([{ success: false, code: 'E3002', message: 'Invalid token' }]);

    await assert.rejects(sendRunFrame(), /Invalid token/);
    assert.equal(sends(), 1);
});
