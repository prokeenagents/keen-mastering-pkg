import WSConnectAPI from './connect';
import { CHAT_SETTINGS } from './settings';
import { byteLength, FatalSendError, generateRequestId, sleep } from './utils';

type OutboundFrame = App.Chat.OutboundFrame;
type InitialRunPayload = App.Chat.InitialRunPayload;
type NodeTaskRequest = App.Chat.NodeTaskRequest;
type ContextRunPayload = App.Chat.ContextRunPayload;
type SendRequestOptions = App.Chat.SendRequestOptions;
type SendResult = App.Chat.SendResult;

/**
 * Payload accepted by execute(). The chat client sends one of:
 *   - InitialRunPayload — first prompt
 *   - NodeTaskRequest   — per-node continuation
 *   - ContextRunPayload — per-copy in a parallelContextTask fan-out
 * Typed explicitly so TaskQueue and ChatAPI catch shape mismatches
 * at compile time.
 */
export type RunPayload = InitialRunPayload | NodeTaskRequest | ContextRunPayload;

/**
 * Per-call overrides for retry policy. Initial-node sends use bounded
 * retries (10 attempts) because failure means the user's request
 * never started. Continuation sends use Infinity because the flow is
 * already alive on the server and we should keep trying until the
 * socket comes back.
 */
export interface ExecuteOptions {
    maxRetries?: number;
    /**
     * The node-visit id: ONE requestId for a node visit's whole
     * life — every retry and every re-send after a resume carries it, so the
     * relay can answer a re-send from its reply buffer or join the dispatch in
     * flight instead of running the node again. Minted here only when absent.
     */
    requestId?: string;
    /**
     * Checked at every transport-retry boundary: true stops the loop
     * (`{ ok: false, error: 'cancelled' }`). TaskQueue passes "this run was
     * cancelled or its connection was lost", so a frame of an ended flow never
     * goes out on the next socket.
     */
    isAborted?: () => boolean;
}

/**
 * Reusable 'run' sender — one SendRequest per WSConnectAPI is the
 * typical usage (see ChatAPI in index.ts); each execute(payload, opts)
 * call uses opts.requestId (the node-visit id) or mints a
 * fresh one, so separate sends never share an id while every retry of
 * one node visit does.
 *
 * Constructed with a WSConnectAPI — the underlying transport. The
 * private send() method gates every outbound frame on
 * connection.isReady() so a request that arrives while the socket
 * is closed (or not yet resumed) simply fails its attempt and is retried on the next loop
 * iteration; nothing is ever sent on a half-open socket.
 *
 * Lifecycle:
 *   const req = new SendRequest(wsConnectApi, { onAttempt });
 *   const result = await req.execute({ promptMessage: "hello" });
 *   if (result.ok) { ... await response via ResponseAPI.waitFor(result.requestId) ... }
 *
 * Cancel by calling .cancel() — any sleeping retry stops at the next
 * attempt boundary and execute() resolves with { ok: false, error: 'cancelled' }.
 */
export default class SendRequest {
    private readonly defaultMaxRetries: number;
    private readonly retryDelayMs: number;
    private readonly onAttempt?: SendRequestOptions['onAttempt'];

    private cancelled = false;

    /**
     * The re-send registry: every frame handed to the socket and
     * not yet answered, by requestId, in the order first sent. A frame leaves
     * when ResponseAPI sees an envelope for its requestId (settle). After a
     * `resumed`, resendAll() re-sends each entry with its ORIGINAL requestId.
     */
    private readonly sent = new Map<string, OutboundFrame>();

    constructor(
        private readonly connection: WSConnectAPI,
        options: SendRequestOptions = {}
    ) {
        this.defaultMaxRetries = options.maxRetries ?? CHAT_SETTINGS.INITIAL_MAX_RETRIES;
        this.retryDelayMs = options.retryDelayMs ?? CHAT_SETTINGS.RETRY_DELAY_MS;
        this.onAttempt = options.onAttempt;
    }

    /**
     * Build the 'run' frame and run the retry loop until the connection
     * accepts it or attempts are exhausted. Returns the discriminated
     * SendResult carrying the freshly-minted requestId so the caller
     * can pair it with ResponseAPI.waitFor; never throws on transport
     * failure.
     *
     * Pass opts.maxRetries to override the SendRequest-level default
     * per call — TaskQueue passes Infinity for non-initial node sends
     * so a brief disconnect during a flow does not lose the work.
     */
    async execute(payload: RunPayload, opts?: ExecuteOptions): Promise<SendResult> {
        const requestId = opts?.requestId ?? generateRequestId();
        const maxRetries = opts?.maxRetries ?? this.defaultMaxRetries;
        const frame: OutboundFrame = {
            event: 'run',
            data: {
                requestId,
                payload
            }
        };

        /**
         * Fail fast on an UNDELIVERABLE frame. A frame past MAX_FRAME_BYTES can
         * never cross the relay→engine hop (NATS max_payload), so it fails the
         * SAME way on every attempt — and a continuation retries with an
         * infinite budget, which would loop forever (the relay drops it / closes
         * the socket, never a clean envelope). Reject it as NON-retryable here so
         * the caller's catch aborts the run with a clear reason instead of hanging.
         */
        const bytes = byteLength(JSON.stringify(frame));
        if (bytes > CHAT_SETTINGS.MAX_FRAME_BYTES) {
            const mb = (n: number): string => (n / (1024 * 1024)).toFixed(1);
            throw new FatalSendError(
                `frame is ${mb(bytes)}MB, over the ${mb(CHAT_SETTINGS.MAX_FRAME_BYTES)}MB limit — it cannot cross the relay→engine hop and would retry forever; aborting the run. Reduce the payload (large dictionary/session values, a huge script result, or an oversized prompt).`
            );
        }

        let attempt = 0;

        while (attempt < maxRetries) {
            attempt += 1;

            if (this.cancelled || opts?.isAborted?.() === true) {
                return { ok: false, error: 'cancelled', attempts: attempt - 1 };
            }

            const sent = this.send(frame);

            this.onAttempt?.({ attempt, requestId, sent });

            if (sent) {
                this.sent.set(requestId, frame);
                return { ok: true, requestId, attempts: attempt };
            }

            if (attempt < maxRetries) {
                await sleep(this.retryDelayMs);
            }
        }

        return {
            ok: false,
            error: `failed to send after ${attempt} attempts`,
            attempts: attempt
        };
    }

    /**
     * Mark the request as cancelled. The next retry boundary will see
     * the flag and bail out. If execute() has already resolved this is
     * a no-op.
     *
     * Note: this is a process-level flag and cancels ALL in-flight
     * execute() calls on this SendRequest instance.
     */
    cancel(): void {
        this.cancelled = true;
    }

    /**
     * A reply for `requestId` arrived: the frame leaves the re-send registry.
     */
    settle(requestId: string): void {
        this.sent.delete(requestId);
    }

    /**
     * Forget frames (a flow ended — success, cancel, or a lost connection):
     * the given requestIds, or every one.
     */
    forget(requestIds?: Iterable<string>): void {
        if (!requestIds) {
            this.sent.clear();
            return;
        }

        for (const requestId of requestIds) {
            this.sent.delete(requestId);
        }
    }

    /** True when the frame `requestId` went out and is not answered yet. */
    isAwaited(requestId: string): boolean {
        return this.sent.has(requestId);
    }

    /** The requestIds still awaited, in the order first sent. */
    awaited(): string[] {
        return Array.from(this.sent.keys());
    }

    /**
     * After `resumed`: re-send every frame still awaited, in the
     * original order, each with its ORIGINAL requestId — a shallow copy whose
     * `payload.userContext.accessToken` is the current token (the relay
     * verifies every frame). Returns how many went out.
     */
    resendAll(accessToken: string): number {
        let count = 0;

        for (const [requestId, frame] of this.sent) {
            if (frame.event !== 'run') {
                continue;
            }

            const payload = frame.data.payload as RunPayload & { userContext?: Record<string, unknown> };
            const copy: OutboundFrame = {
                event: 'run',
                data: {
                    requestId,
                    payload: {
                        ...payload,
                        ...(payload.userContext ? { userContext: { ...payload.userContext, accessToken } } : {})
                    } as RunPayload
                }
            };

            this.sent.set(requestId, copy);

            if (this.connection.sendFrame(copy)) {
                count += 1;
            }
        }

        return count;
    }

    /**
     * Private transport step — gated on connection.isReady(): the socket is
     * OPEN AND bound to the flow's cid. Between a reconnect's `welcome` and
     * its `resumed` the socket is open but still on the welcome cid, so a
     * continuation sent then would carry the old cid and be refused E2001
     * (load-bearing). Returns the boolean WSConnectAPI.sendFrame
     * gives us so the loop can decide retry vs. resolution.
     */
    private send(frame: OutboundFrame): boolean {
        if (!this.connection.isReady()) {
            return false;
        }

        return this.connection.sendFrame(frame);
    }
}
