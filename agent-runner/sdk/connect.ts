import ResponseAPI from './response';

type ConnectStatus = App.Chat.ConnectStatus;
type InboundFrame = App.Chat.InboundFrame;
type OutboundFrame = App.Chat.OutboundFrame;
type StatusHandler = App.Chat.StatusHandler;
type SystemHandler = App.Chat.SystemHandler;
type WelcomeHandler = App.Chat.WelcomeHandler;
type WelcomePayload = App.Chat.WelcomePayload;
type Unsubscribe = App.Chat.Unsubscribe;

/**
 * WSConnectAPI — owns the WebSocket lifecycle.
 *
 * Responsibilities (transport-layer only):
 *   - Open and close a WebSocket to the Keen server endpoint.
 *   - Capture the connection's correlationID from the relay's
 *     'welcome' frame (sent once, immediately after WS open).
 *     correlationID is persistent per WS connection and used as
 *     the per-chat identifier across all subsequent sends.
 *   - Track current connection status; expose via getStatus + onStatus.
 *   - Route inbound frames to ResponseAPI (envelope / stream split
 *     lives there).
 *   - Surface socket-level events (open, close, error, parse failure)
 *     as system messages via onSystem.
 *   - Expose sendFrame() — used by SendRequest, gated on the socket
 *     being OPEN; returns boolean so retry logic stays in SendRequest.
 */
export default class WSConnectAPI {
    private ws: WebSocket | null = null;
    private currentStatus: ConnectStatus = 'disconnected';
    private correlationID: string | null = null;
    private welcomeResolver: ((cid: string) => void) | null = null;
    private welcomePromise: Promise<string>;

    private readonly statusHandlers = new Set<StatusHandler>();
    private readonly systemHandlers = new Set<SystemHandler>();
    private readonly welcomeHandlers = new Set<WelcomeHandler>();

    constructor(
        private url: string,
        private readonly responseApi: ResponseAPI
    ) {
        this.welcomePromise = this.makeWelcomePromise();
    }

    /**
     * Open the WebSocket. No-op if a socket is already constructed
     * (use disconnect() first if you need to reconnect).
     *
     * The transport carries NO auth — the access_token rides inside the
     * initial run payload (kept out of URLs and proxy logs). Engine
     * validates it on the initial run, returns a correlationToken in
     * the bundle, and every subsequent per-node call carries that
     * server-derived token instead of the user's long-lived
     * access_token.
     */
    connect(): void {
        if (this.ws) {
            return;
        }

        try {
            this.ws = new WebSocket(this.url);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            this.emitSystem(`failed to construct WebSocket: ${message}`);
            this.ws = null;
            return;
        }

        this.setStatus('connecting');

        this.ws.onopen = () => {
            this.setStatus('connected');
            this.emitSystem(`open ${this.url}`);
        };

        this.ws.onclose = (event) => {
            this.setStatus('disconnected');
            this.ws = null;
            this.resetWelcome();
            const reason = event.reason ? `, ${event.reason}` : '';

            this.emitSystem(`close (code ${event.code}${reason})`);
        };

        this.ws.onerror = () => {
            this.emitSystem(`socket error`);
        };

        this.ws.onmessage = (event) => {
            let parsed: InboundFrame;

            try {
                parsed = JSON.parse(event.data as string) as InboundFrame;
            } catch {
                this.emitSystem(`non-JSON frame: ${String(event.data)}`);
                return;
            }

            if (this.maybeHandleWelcome(parsed)) {
                return;
            }

            this.responseApi.handle(parsed);
        };
    }

    /**
     * Close the WebSocket if open. The onclose handler will fire and
     * notify status subscribers; correlationID is cleared so the next
     * connect() starts fresh.
     */
    disconnect(): void {
        this.ws?.close();
    }

    /**
     * True only when the socket is in OPEN state — the precondition
     * SendRequest checks before pushing a frame.
     */
    isConnected(): boolean {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }

    /**
     * Current lifecycle state. Updated synchronously when the socket
     * transitions; subscribe via onStatus to react in React state.
     */
    getStatus(): ConnectStatus {
        return this.currentStatus;
    }

    getUrl(): string {
        return this.url;
    }

    /**
     * The correlationID relay assigned to this WS connection via the
     * 'welcome' frame. null until the welcome has arrived; after that
     * stable for the WS lifetime, cleared on disconnect.
     */
    getCorrelationID(): string | null {
        return this.correlationID;
    }

    /**
     * Set the correlationID externally. Used by TaskQueue when a relay
     * doesn't send a welcome — TaskQueue mints a client-side fallback
     * cid and registers it here so the connection has a consistent id
     * for cancel signals and future calls.
     */
    setCorrelationID(cid: string): void {
        this.correlationID = cid;
        this.welcomeResolver?.(cid);
        this.welcomeResolver = null;

        for (const handler of this.welcomeHandlers) {
            handler({ correlationID: cid });
        }
    }

    /**
     * Resolve with the correlationID once the relay's welcome frame
     * has arrived. Useful for callers that need to gate sends on the
     * connection being fully established. It never rejects: a close
     * before the welcome swaps in a fresh pending promise (resetWelcome),
     * so a caller that must fail fast races it against onStatus
     * 'disconnected' (agent-runner's run.ts does).
     */
    whenReady(): Promise<string> {
        if (this.correlationID) {
            return Promise.resolve(this.correlationID);
        }

        return this.welcomePromise;
    }

    /**
     * Push a frame onto the socket. Returns true if the frame was
     * queued on an OPEN socket, false otherwise. Used by SendRequest
     * as the underlying transport call; the retry logic lives in
     * SendRequest, not here.
     */
    sendFrame(frame: OutboundFrame): boolean {
        if (!this.isConnected() || !this.ws) {
            return false;
        }

        this.ws.send(JSON.stringify(frame));
        return true;
    }

    onStatus(handler: StatusHandler): Unsubscribe {
        this.statusHandlers.add(handler);

        return () => {
            this.statusHandlers.delete(handler);
        };
    }

    onSystem(handler: SystemHandler): Unsubscribe {
        this.systemHandlers.add(handler);

        return () => {
            this.systemHandlers.delete(handler);
        };
    }

    onWelcome(handler: WelcomeHandler): Unsubscribe {
        this.welcomeHandlers.add(handler);

        return () => {
            this.welcomeHandlers.delete(handler);
        };
    }

    private setStatus(status: ConnectStatus): void {
        if (this.currentStatus === status) {
            return;
        }

        this.currentStatus = status;

        for (const handler of this.statusHandlers) {
            handler(status);
        }
    }

    private emitSystem(text: string): void {
        for (const handler of this.systemHandlers) {
            handler(text);
        }
    }

    /**
     * If the inbound frame is the relay's welcome (event === 'welcome'
     * with a correlationID in data), capture the cid and fire
     * onWelcome subscribers. Returns true to short-circuit — the
     * welcome is NOT a response/stream frame, no need to hand it to
     * ResponseAPI.
     */
    private maybeHandleWelcome(frame: InboundFrame): boolean {
        if (frame.event !== 'welcome') {
            return false;
        }

        const cid = (frame.data as Partial<WelcomePayload> | undefined)?.correlationID;

        if (typeof cid !== 'string' || cid.length === 0) {
            this.emitSystem(`malformed welcome frame: ${JSON.stringify(frame.data)}`);
            return true;
        }

        this.correlationID = cid;
        this.welcomeResolver?.(cid);
        this.welcomeResolver = null;
        this.emitSystem(`welcome — correlationID ${cid}`);

        for (const handler of this.welcomeHandlers) {
            handler({ correlationID: cid });
        }

        return true;
    }

    /**
     * Reset welcome state on disconnect so a subsequent connect()
     * waits for a fresh welcome (new connection = new cid).
     */
    private resetWelcome(): void {
        this.correlationID = null;
        this.welcomePromise = this.makeWelcomePromise();
    }

    private makeWelcomePromise(): Promise<string> {
        return new Promise<string>((resolve) => {
            this.welcomeResolver = resolve;
        });
    }
}
