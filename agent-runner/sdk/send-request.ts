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
}

/**
 * Reusable 'run' sender — one SendRequest per WSConnectAPI is the
 * typical usage (see ChatAPI in index.ts); each execute(payload, opts)
 * call mints a fresh requestId so multiple sequential sends never
 * share an id.
 *
 * Constructed with a WSConnectAPI — the underlying transport. The
 * private send() method gates every outbound frame on
 * connection.isConnected() so a request that arrives while the socket
 * is closed simply fails its attempt and is retried on the next loop
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
        const requestId = generateRequestId();
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

            if (this.cancelled) {
                return { ok: false, error: 'cancelled', attempts: attempt - 1 };
            }

            const sent = this.send(frame);

            this.onAttempt?.({ attempt, requestId, sent });

            if (sent) {
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
     * Private transport step — gated on connection.isConnected() so
     * the retry loop never pushes a frame onto a half-open socket.
     * Returns the boolean WSConnectAPI.sendFrame gives us so the
     * loop can decide retry vs. resolution.
     */
    private send(frame: OutboundFrame): boolean {
        if (!this.connection.isConnected()) {
            return false;
        }

        return this.connection.sendFrame(frame);
    }
}
