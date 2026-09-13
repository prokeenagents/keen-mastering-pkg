import { CHAT_SETTINGS } from './settings';

type Envelope = App.Chat.Envelope;
type InboundFrame = App.Chat.InboundFrame;
type ResponseHandler = App.Chat.ResponseHandler;
type StreamEventHandler = App.Chat.StreamEventHandler;
type ResponseAPIOptions = App.Chat.ResponseAPIOptions;
type Unsubscribe = App.Chat.Unsubscribe;

interface Pending {
    resolve: (envelope: Envelope) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

/**
 * ResponseAPI — the inbound counterpart to SendRequest.
 *
 * Receives parsed frames from WSConnectAPI (handle() is called by
 * the WS message handler) and routes them:
 *   - Frames with an envelope are 'response' frames — resolve any
 *     pending waitFor for that requestId, notify onResponse subscribers.
 *   - Frames without an envelope are 'stream' frames (engine → user
 *     progress) — notify onStream subscribers.
 *
 * Lifecycle is wired by ChatAPI / useRelay:
 *   const responses = new ResponseAPI();
 *   const ws = new WSConnectAPI(url, responses);
 *   ws.connect();
 *
 *   const sent = await new SendRequest(ws).execute("hi");
 *   const envelope = await responses.waitFor(sent.requestId);
 */
export default class ResponseAPI {
    private readonly defaultTimeoutMs: number;
    private readonly pending = new Map<string, Pending>();
    private readonly responseHandlers = new Set<ResponseHandler>();
    private readonly streamHandlers = new Set<StreamEventHandler>();

    constructor(options: ResponseAPIOptions = {}) {
        this.defaultTimeoutMs = options.defaultTimeoutMs ?? CHAT_SETTINGS.RESPONSE_TIMEOUT_MS;
    }

    /**
     * Entry point used by WSConnectAPI's onmessage handler. Routes the
     * parsed frame by envelope-presence:
     *   - has envelope → resolve any waitFor, fire onResponse
     *   - no envelope  → fire onStream
     */
    handle(frame: InboundFrame): void {
        const envelope = frame.data?.envelope;
        const requestId = typeof frame.data?.requestId === 'string' ? frame.data.requestId : undefined;

        if (envelope) {
            if (requestId) {
                const pending = this.pending.get(requestId);

                if (pending) {
                    clearTimeout(pending.timer);
                    this.pending.delete(requestId);
                    pending.resolve(envelope);
                }
            }

            for (const handler of this.responseHandlers) {
                handler(envelope, requestId ?? '');
            }

            return;
        }

        for (const handler of this.streamHandlers) {
            handler(frame.event, frame.data, requestId);
        }
    }

    /**
     * Resolve with the envelope when a response frame matching
     * requestId arrives. Rejects on timeout (defaultTimeoutMs unless
     * overridden) so callers cannot wait forever on a lost reply.
     *
     * Calling waitFor with the same requestId twice replaces the
     * earlier waiter — typically a bug at the call site, so we reject
     * the earlier promise to surface it.
     */
    waitFor(requestId: string, timeoutMs?: number): Promise<Envelope> {
        const previous = this.pending.get(requestId);

        if (previous) {
            clearTimeout(previous.timer);
            previous.reject(new Error(`waitFor(${requestId}) replaced by a newer waiter`));
            this.pending.delete(requestId);
        }

        return new Promise<Envelope>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new Error(`waitFor(${requestId}) timed out after ${timeoutMs ?? this.defaultTimeoutMs}ms`));
            }, timeoutMs ?? this.defaultTimeoutMs);

            this.pending.set(requestId, { resolve, reject, timer });
        });
    }

    /**
     * Subscribe to every response envelope. Useful for log / stats /
     * inflight UI panels that want to react to every reply, not just
     * a single awaited one.
     */
    onResponse(handler: ResponseHandler): Unsubscribe {
        this.responseHandlers.add(handler);

        return () => {
            this.responseHandlers.delete(handler);
        };
    }

    /**
     * Subscribe to every stream event (engine → user progress, no
     * envelope). The bottom terminal in the demo UI subscribes here.
     */
    onStream(handler: StreamEventHandler): Unsubscribe {
        this.streamHandlers.add(handler);

        return () => {
            this.streamHandlers.delete(handler);
        };
    }

    /**
     * Reject all pending waitFor promises and clear subscribers.
     * Call when tearing down the connection so awaiters do not hang
     * past the lifetime of their transport.
     */
    dispose(): void {
        for (const [requestId, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(new Error(`waitFor(${requestId}) cancelled by ResponseAPI.dispose()`));
        }

        this.pending.clear();
        this.responseHandlers.clear();
        this.streamHandlers.clear();
    }
}
