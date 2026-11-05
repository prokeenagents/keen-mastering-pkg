import ResponseAPI from './response';
import { CHAT_SETTINGS } from './settings';
import { CONNECTION_LOST_TEXT, ConnectionLostError, reconnectDelayMs } from './utils';

type ConnectStatus = App.Chat.ConnectStatus;
type InboundFrame = App.Chat.InboundFrame;
type OutboundFrame = App.Chat.OutboundFrame;
type StatusHandler = App.Chat.StatusHandler;
type SystemHandler = App.Chat.SystemHandler;
type WelcomeHandler = App.Chat.WelcomeHandler;
type WelcomePayload = App.Chat.WelcomePayload;
type ResumeHandler = App.Chat.ResumeHandler;
type Unsubscribe = App.Chat.Unsubscribe;

/**
 * What the connection needs from the layer above it (ChatAPI wires it) to
 * resume a flow after a dropped socket.
 */
export interface ConnectHost {
    /** A flow is running (TaskQueue.isRunning()). */
    flowActive(): boolean;
    /** The identity a `resume` frame carries: the run's userId and the CURRENT access token. */
    identity(): { userId: string; accessToken: string };
    /** True when ChatAPIOptions.onAuthExpired is set. */
    hasAuthHook(): boolean;
    /** Call onAuthExpired once; a string is applied (setAccessToken) and returned. May throw. */
    refreshAccessToken(): Promise<string | null>;
    /** Re-send every awaited frame with its original requestId (SendRequest.resendAll). */
    resendAll(): number;
    /** The running flow cannot go on from this client (TaskQueue.connectionLost). */
    lost(err: ConnectionLostError): void;
}

/** `welcome.limits.promptChars` when the relay sent a positive number. */
function promptCharsOf(data: unknown): number | null {
    const limits = (data as { limits?: { promptChars?: unknown } } | undefined)?.limits;
    const v = limits?.promptChars;

    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/** The cid a flow runs on, and the handle that resumes it. */
interface Binding {
    cid: string;
    resumeToken: string | null;
    protocol: number;
    graceMs: number | null;
    /** `welcome.limits.promptChars` — the longest prompt the relay accepts (E2101 above it); null on a relay that sends no limits. */
    promptChars: number | null;
}

/**
 * WSConnectAPI — owns the WebSocket lifecycle.
 *
 * Responsibilities (transport-layer only):
 *   - Open and close a WebSocket to the Keen server endpoint.
 *   - Capture the connection's correlationID from the relay's
 *     'welcome' frame (sent once, immediately after WS open).
 *   - Reconnect after a drop and RESUME a running flow on its old cid:
 *     the state machine below.
 *   - Track current connection status; expose via getStatus + onStatus.
 *   - Route inbound frames to ResponseAPI (envelope / stream split
 *     lives there). `welcome`, `pong`, `resumed` and `resume-refused`
 *     are consumed here and never reach ResponseAPI.
 *   - Surface socket-level events (open, close, error, parse failure,
 *     reconnect, resume) as system messages via onSystem.
 *   - Expose sendFrame() — used by SendRequest, gated on isReady();
 *     returns boolean so retry logic stays in SendRequest.
 *
 * The state machine:
 *
 *   connecting ──welcome──────────────────────────▶ connected (ready)
 *   connected ──close (not disconnect(), not 4409)─▶ reconnecting
 *                                                     │ backoff: random(0, min(10 s, 1 s·2^(n−1)))
 *                                                     │ (1012: random(0, 1 s))
 *                                                     ▼ new socket
 *   reconnecting ──welcome, no resume needed──────▶ connected (ready, NEW cid)
 *   reconnecting ──welcome, resume needed─────────▶ (not ready) send `resume`
 *     not ready ──resumed───────────────────────▶ connected (ready, OLD cid);
 *                                                  onResume; re-send awaited frames; deferred cancel
 *     not ready ──resume-refused token──────────▶ onAuthExpired → re-resume
 *                                                  (no hook: wait for setAccessToken)
 *     not ready ──resume-refused unavailable────▶ re-resume after the backoff, same socket
 *     not ready ──resume-refused gone/protocol──▶ connected (ready, NEW cid); the flow is lost
 *   connected ──run active, 15 s of silence───────▶ close 4000 → reconnecting
 *   any ──disconnect()────────────────────────────▶ disconnected (close 1000, no reconnect)
 *   any ──close 4409──────────────────────────────▶ disconnected; the flow is lost, no cancel
 *
 * A close before the FIRST welcome of this instance stays `disconnected`
 * (no reconnect), so a bad URL or origin fails fast. The status stays
 * `reconnecting` until the socket is ready again (a resume is part of
 * reconnecting).
 *
 * The resume token is held in memory only — never in a URL, in storage or
 * in a system message.
 */
export default class WSConnectAPI {
    private ws: WebSocket | null = null;
    private currentStatus: ConnectStatus = 'disconnected';
    /** The flow-facing cid: the welcome cid, or the OLD cid while it is being resumed. */
    private correlationID: string | null = null;
    private welcomeResolver: ((cid: string) => void) | null = null;
    private welcomePromise: Promise<string>;

    /** The binding of correlationID (its resume handle and the relay's protocol). */
    private bound: Binding | null = null;
    /** The current socket's own welcome while a resume of `bound` is pending. */
    private fresh: Binding | null = null;
    /** True once the socket is open AND bound to the flow's cid (welcome, or resumed). */
    private ready = false;
    /** At least one `run` frame was sent on `bound.cid`. */
    private runSentOnCid = false;
    /** A welcome has been seen on this instance — reconnects happen only after one. */
    private everWelcomed = false;
    /** disconnect() was called — no reconnect. */
    private userClosed = false;
    /** Reconnect attempts since the last ready socket. */
    private attempt = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    /** Bumped per socket, so a late callback (a hook, a timer) can tell its socket is gone. */
    private socketEpoch = 0;

    /** A `resume` was sent on this socket and is not answered yet. */
    private resumeInFlight = false;
    /** Refused resumes on this socket (the relay closes 1008 after 5). */
    private refusals = 0;
    private resumeTimer: ReturnType<typeof setTimeout> | null = null;
    /** Waiting for setAccessToken() to change the token (no onAuthExpired hook). */
    private awaitingTokenOther: string | null = null;
    /** A cancel for this cid, to send right after the next `resumed`. */
    private deferredCancel: string | null = null;

    private lastInboundAt = 0;
    private activeSince: number | null = null;
    private livenessTimer: ReturnType<typeof setInterval> | null = null;

    private host: ConnectHost | null = null;

    private readonly statusHandlers = new Set<StatusHandler>();
    private readonly systemHandlers = new Set<SystemHandler>();
    private readonly welcomeHandlers = new Set<WelcomeHandler>();
    private readonly resumeHandlers = new Set<ResumeHandler>();

    constructor(
        private url: string,
        private readonly responseApi: ResponseAPI
    ) {
        this.welcomePromise = this.makeWelcomePromise();
    }

    /** Wire the layer above (ChatAPI). Without a host nothing is ever resumed. */
    setHost(host: ConnectHost): void {
        this.host = host;
    }

    /**
     * Open the WebSocket. No-op if a socket is already constructed or a
     * reconnect is scheduled (use disconnect() first for a fresh start).
     *
     * The transport carries NO auth — the access_token rides inside every
     * run payload (and the `resume` frame), kept out of URLs and proxy logs.
     */
    connect(): void {
        if (this.ws || this.reconnectTimer) {
            return;
        }

        this.userClosed = false;
        this.openSocket();
    }

    /**
     * Close the WebSocket (code 1000) and stop reconnecting. The onclose
     * handler notifies status subscribers; correlationID is cleared so the
     * next connect() starts fresh. ChatAPI.disconnect() cancels a running
     * flow BEFORE it calls this.
     */
    disconnect(): void {
        this.userClosed = true;
        this.deferredCancel = null;
        this.clearTimers();

        if (this.ws) {
            this.ws.close(1000);
            return;
        }

        this.ready = false;
        this.resetWelcome();
        this.setStatus('disconnected');
    }

    /**
     * The app is dropping this connection (ChatAPI.disconnect() is about to
     * cancel and close): stop reconnecting and never defer a cancel into a
     * resume that would be closed right away.
     */
    markClosing(): void {
        this.userClosed = true;
        this.deferredCancel = null;
        this.clearTimers();
    }

    /**
     * True only when the socket is in OPEN state.
     */
    isConnected(): boolean {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }

    /**
     * True when the socket is OPEN and bound to the flow's cid: after a
     * welcome that needed no resume, or after `resumed`. Run, cancel and ping
     * frames are sent only then.
     */
    isReady(): boolean {
        return this.ready && this.isConnected();
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
     * The correlationID of this connection: the welcome's, or — while a
     * dropped socket is being resumed — the flow's old one. null until the
     * first welcome, and after a close that needs no resume.
     */
    getCorrelationID(): string | null {
        return this.correlationID;
    }

    /**
     * The longest prompt (in characters) the relay accepts — `welcome.limits.promptChars`
     * (20000 today). null until a welcome carried it (an older relay sends none). A longer
     * prompt is refused with E2101; use this to show a counter and stop the send.
     */
    getPromptLimit(): number | null {
        return this.bound?.promptChars ?? null;
    }

    /**
     * Set the correlationID externally. Used by TaskQueue when a relay
     * doesn't send a welcome — TaskQueue mints a client-side fallback
     * cid and registers it here so the connection has a consistent id
     * for cancel signals and future calls.
     */
    setCorrelationID(cid: string): void {
        this.correlationID = cid;
        this.bound = { cid, resumeToken: null, protocol: 1, graceMs: null, promptChars: null };
        this.runSentOnCid = false;
        // Ready only on an open socket of a relay that never sent a welcome; a
        // relay that does (a reconnect waits for its welcome) keeps the gate.
        this.ready = this.isConnected() && !this.everWelcomed;
        this.welcomeResolver?.(cid);
        this.welcomeResolver = null;

        for (const handler of this.welcomeHandlers) {
            handler({ correlationID: cid });
        }
    }

    /**
     * Resolve with the correlationID once the relay's welcome frame
     * has arrived. It never rejects: a close before the welcome swaps in a
     * fresh pending promise (resetWelcome), so a caller that must fail fast
     * races it against onStatus 'disconnected' (agent-runner's run.ts does).
     */
    whenReady(): Promise<string> {
        if (this.correlationID) {
            return Promise.resolve(this.correlationID);
        }

        return this.welcomePromise;
    }

    /**
     * Push a frame onto the socket. Returns true if the frame was queued on a
     * READY socket, false otherwise (closed, or open but not resumed yet).
     * The retry logic lives in SendRequest, not here.
     */
    sendFrame(frame: OutboundFrame): boolean {
        if (!this.isReady() || !this.ws) {
            return false;
        }

        this.ws.send(JSON.stringify(frame));

        if (frame.event === 'run') {
            this.runSentOnCid = true;
        }

        return true;
    }

    /**
     * True when a cancel for `cid` can be delivered later by resuming it: the
     * cid is the bound one, it has run something, the relay speaks protocol 2
     * and the SDK holds its resume token.
     */
    canResume(cid: string): boolean {
        return (
            !this.userClosed &&
            this.bound !== null &&
            this.bound.cid === cid &&
            this.correlationID === cid &&
            this.runSentOnCid &&
            this.bound.resumeToken !== null &&
            this.bound.protocol >= 2
        );
    }

    /**
     * Queue a cancel for `cid`: the socket is away or not
     * resumed yet, so the cancel goes out right after the next `resumed`. The
     * resume proves ownership of the cid first. If the relay answers `gone`,
     * the flow is already over and the cancel is dropped.
     */
    deferCancel(cid: string): void {
        this.deferredCancel = cid;
        this.maybeResumeNow();
    }

    /**
     * The access token changed (ChatAPI.setAccessToken). If a resume was
     * refused `token` and no onAuthExpired hook exists, re-send it now.
     */
    tokenChanged(accessToken: string): void {
        if (this.awaitingTokenOther !== null && accessToken !== this.awaitingTokenOther) {
            this.awaitingTokenOther = null;
            this.sendResume();
        }
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

    /**
     * Subscribe to a resumed flow: fires after `resumed`, before the awaited
     * frames are re-sent. The token stream emitted during the gap is not
     * replayed, so a site re-reads its chat history when the turn ends.
     */
    onResume(handler: ResumeHandler): Unsubscribe {
        this.resumeHandlers.add(handler);

        return () => {
            this.resumeHandlers.delete(handler);
        };
    }

    // ------------------------------------------------------------ socket

    private openSocket(): void {
        let ws: WebSocket;

        try {
            ws = new WebSocket(this.url);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            this.emitSystem(`failed to construct WebSocket: ${message}`);
            this.ws = null;

            if (this.everWelcomed && !this.userClosed) {
                this.scheduleReconnect(1006, '');
            }
            return;
        }

        this.ws = ws;
        this.socketEpoch += 1;
        this.ready = false;
        this.refusals = 0;
        this.resumeInFlight = false;
        this.awaitingTokenOther = null;
        this.fresh = null;

        if (!this.everWelcomed) {
            this.setStatus('connecting');
        }

        ws.onopen = () => {
            this.lastInboundAt = Date.now();
            if (!this.everWelcomed) {
                this.setStatus('connected');
            }
            this.emitSystem(`open ${this.url}`);
            this.startLiveness();
        };

        ws.onclose = (event) => {
            this.handleClose(event.code, event.reason ?? '');
        };

        ws.onerror = () => {
            this.emitSystem(`socket error`);
        };

        ws.onmessage = (event) => {
            this.lastInboundAt = Date.now();

            let parsed: InboundFrame;

            try {
                parsed = JSON.parse(event.data as string) as InboundFrame;
            } catch {
                this.emitSystem(`non-JSON frame: ${String(event.data)}`);
                return;
            }

            if (this.maybeHandleControl(parsed)) {
                return;
            }

            this.responseApi.handle(parsed);
        };
    }

    /**
     * Close the current socket from our side and handle the close at once —
     * a half-open TCP may never deliver the close handshake's onclose.
     */
    private forceClose(code: number, reason: string, wireCode: number = code): void {
        const ws = this.ws;

        if (!ws) {
            return;
        }

        ws.onopen = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;

        try {
            ws.close(wireCode, reason);
        } catch {
            // the socket is dead either way
        }

        this.handleClose(code, reason);
    }

    private handleClose(code: number, reason: string): void {
        this.ws = null;
        this.ready = false;
        this.resumeInFlight = false;
        this.awaitingTokenOther = null;
        this.stopLiveness();

        if (this.resumeTimer) {
            clearTimeout(this.resumeTimer);
            this.resumeTimer = null;
        }

        const why = reason ? `, ${reason}` : '';

        if (this.userClosed) {
            this.emitSystem(`close (code ${code}${why})`);
            this.resetWelcome();
            this.setStatus('disconnected');
            return;
        }

        if (code === 4409) {
            // Superseded: this cid was resumed on a newer connection. No cancel, no reconnect.
            this.emitSystem(`close (code ${code}${why}) — ${CONNECTION_LOST_TEXT.SUPERSEDED}`);
            this.userClosed = true;
            this.deferredCancel = null;
            this.resetWelcome();
            this.setStatus('disconnected');
            if (this.host?.flowActive()) {
                this.host.lost(new ConnectionLostError(CONNECTION_LOST_TEXT.SUPERSEDED, { code: 'E5201' }));
            }
            return;
        }

        if (!this.everWelcomed) {
            this.emitSystem(`close (code ${code}${why})`);
            this.resetWelcome();
            this.setStatus('disconnected');
            return;
        }

        const flowRunning = this.host?.flowActive() === true;
        const cid = this.correlationID;
        let keepCid = cid !== null && this.canResume(cid) && (flowRunning || this.deferredCancel === cid);

        if (flowRunning && cid !== null && this.runSentOnCid && !keepCid) {
            // An old relay (no `protocol` in its welcome) cancelled the cid on this close.
            this.host?.lost(new ConnectionLostError(CONNECTION_LOST_TEXT.OLD_RELAY, { code: 'E5201' }));
            keepCid = false;
        }

        if (!keepCid) {
            this.deferredCancel = null;
            this.resetWelcome();
        }

        this.scheduleReconnect(code, why);
    }

    private scheduleReconnect(code: number, why: string): void {
        this.attempt += 1;

        const delay =
            code === 1012
                ? Math.floor(Math.random() * CHAT_SETTINGS.RESTART_JITTER_MS)
                : reconnectDelayMs(this.attempt);

        this.emitSystem(`close (code ${code}${why}) — reconnecting in ${(delay / 1000).toFixed(1)} s (attempt ${this.attempt})`);
        this.setStatus('reconnecting');

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.userClosed) {
                this.openSocket();
            }
        }, delay);
    }

    // ------------------------------------------------------------ control frames

    /**
     * `welcome`, `pong`, `resumed` and `resume-refused` are consumed here.
     * Returns true to short-circuit — they are NOT response/stream frames.
     */
    private maybeHandleControl(frame: InboundFrame): boolean {
        switch (frame.event) {
            case 'welcome':
                this.handleWelcome(frame.data as Partial<WelcomePayload> | undefined);
                return true;
            case 'pong':
                return true;
            case 'resumed':
                this.handleResumed(frame.data as Partial<App.Chat.ResumedPayload> | undefined);
                return true;
            case 'resume-refused':
                this.handleResumeRefused(frame.data as Partial<App.Chat.ResumeRefusedPayload> | undefined);
                return true;
            default:
                return false;
        }
    }

    private handleWelcome(data: Partial<WelcomePayload> | undefined): void {
        const cid = data?.correlationID;

        if (typeof cid !== 'string' || cid.length === 0) {
            this.emitSystem(`malformed welcome frame: ${JSON.stringify(data)}`);
            return;
        }

        const welcome: Binding = {
            cid,
            resumeToken: typeof data?.resumeToken === 'string' && data.resumeToken.length > 0 ? data.resumeToken : null,
            protocol: typeof data?.protocol === 'number' ? data.protocol : 1,
            graceMs: typeof data?.graceMs === 'number' ? data.graceMs : null,
            promptChars: promptCharsOf(data)
        };

        this.everWelcomed = true;

        if (this.resumeNeeded()) {
            if (welcome.protocol < 2) {
                // This replica cannot resume (a mixed-version roll-out): the flow is lost.
                this.adopt(welcome);
                this.host?.lost(new ConnectionLostError(CONNECTION_LOST_TEXT.OLD_RELAY, { code: 'E5201' }));
                return;
            }

            this.fresh = welcome;
            this.sendResume();
            return;
        }

        this.adopt(welcome);
    }

    /**
     * "Resume is needed" (§6.1): the bound cid ran something, the SDK holds
     * its resume token, the relay speaks protocol ≥ 2, and a flow is running
     * on it (or a cancel for it waits).
     */
    private resumeNeeded(): boolean {
        const cid = this.correlationID;

        if (cid === null || !this.canResume(cid)) {
            return false;
        }

        return this.host?.flowActive() === true || this.deferredCancel === cid;
    }

    /** Become ready on a NEW cid (the welcome's). */
    private adopt(welcome: Binding): void {
        this.bound = welcome;
        this.fresh = null;
        this.correlationID = welcome.cid;
        this.runSentOnCid = false;
        this.deferredCancel = null;
        this.ready = true;
        this.attempt = 0;
        this.setStatus('connected');
        this.welcomeResolver?.(welcome.cid);
        this.welcomeResolver = null;
        this.emitSystem(`welcome — correlationID ${welcome.cid}`);

        for (const handler of this.welcomeHandlers) {
            handler({ correlationID: welcome.cid });
        }
    }

    /** Send `resume` for the bound cid on this socket (the first frame on it). */
    private sendResume(): void {
        const ws = this.ws;

        if (!ws || !this.isConnected() || this.ready || !this.bound?.resumeToken || !this.fresh) {
            return;
        }

        if (this.refusals >= CHAT_SETTINGS.RESUME_MAX_ATTEMPTS_PER_SOCKET) {
            // The relay would close the 6th with 1008: open a new socket instead.
            // (A browser may close with 1000 or 3000–4999 only; it is handled as a 1008 here.)
            this.forceClose(1008, 'too many resume attempts', 1000);
            return;
        }

        const identity = this.host?.identity() ?? { userId: '', accessToken: '' };
        const frame: OutboundFrame = {
            event: 'resume',
            data: {
                correlationId: this.bound.cid,
                resumeToken: this.bound.resumeToken,
                userContext: { userId: identity.userId, accessToken: identity.accessToken }
            }
        };

        this.resumeInFlight = true;
        this.lastInboundAt = Date.now();
        ws.send(JSON.stringify(frame));
    }

    /** A cancel was deferred while the socket is open and the resume waits on nothing: send it now. */
    private maybeResumeNow(): void {
        if (this.isConnected() && !this.ready && this.fresh && !this.resumeInFlight && this.awaitingTokenOther === null && !this.resumeTimer) {
            this.sendResume();
        }
    }

    private handleResumed(data: Partial<App.Chat.ResumedPayload> | undefined): void {
        if (!this.resumeInFlight || !this.bound) {
            this.emitSystem(`unexpected resumed frame`);
            return;
        }

        const cid = typeof data?.correlationID === 'string' ? data.correlationID : this.bound.cid;
        const detachedMs = typeof data?.detachedMs === 'number' ? data.detachedMs : 0;

        this.resumeInFlight = false;
        this.bound = {
            cid,
            resumeToken: typeof data?.resumeToken === 'string' && data.resumeToken.length > 0 ? data.resumeToken : null,
            protocol: Math.max(2, this.fresh?.protocol ?? 2),
            graceMs: typeof data?.graceMs === 'number' ? data.graceMs : this.bound.graceMs,
            promptChars: this.bound.promptChars
        };
        this.fresh = null;
        this.correlationID = cid;
        this.ready = true;
        this.refusals = 0;
        this.attempt = 0;
        this.setStatus('connected');
        this.emitSystem(`resumed — correlationID ${cid} after ${(detachedMs / 1000).toFixed(1)} s`);

        for (const handler of this.resumeHandlers) {
            handler({ correlationID: cid, detachedMs });
        }

        this.host?.resendAll();

        if (this.deferredCancel === cid) {
            this.deferredCancel = null;
            this.sendFrame({ event: 'cancel', data: { correlationId: cid } });
        }
    }

    private handleResumeRefused(data: Partial<App.Chat.ResumeRefusedPayload> | undefined): void {
        if (!this.resumeInFlight) {
            this.emitSystem(`unexpected resume-refused frame`);
            return;
        }

        this.resumeInFlight = false;
        this.refusals += 1;

        const reason = data?.reason;
        const code = data?.envelope?.code;

        if (reason === 'token') {
            this.emitSystem(`resume refused (token) — waiting for a new access token`);
            this.onTokenRefused();
            return;
        }

        if (reason === 'unavailable') {
            const delay = reconnectDelayMs(this.refusals);

            this.emitSystem(`resume refused (unavailable) — retrying in ${(delay / 1000).toFixed(1)} s`);
            const epoch = this.socketEpoch;

            this.resumeTimer = setTimeout(() => {
                this.resumeTimer = null;
                if (epoch === this.socketEpoch) {
                    this.sendResume();
                }
            }, delay);
            return;
        }

        // gone / protocol (or a reason this SDK does not know): the server will not resume this cid.
        const shown = reason === 'protocol' ? 'protocol' : 'gone';

        this.emitSystem(`resume refused (${shown}) — the server no longer holds this flow`);
        this.giveUpResume(
            new ConnectionLostError(CONNECTION_LOST_TEXT.GONE, {
                code: typeof code === 'string' ? code : shown === 'protocol' ? 'E2001' : 'E5201',
                restartable: true
            })
        );
    }

    /** The resume is over for good: adopt this socket's own cid, then end the flow. */
    private giveUpResume(err: ConnectionLostError): void {
        const welcome = this.fresh;

        if (welcome) {
            this.adopt(welcome);
        }

        if (this.host?.flowActive()) {
            this.host.lost(err);
        }
    }

    /**
     * A `token` refusal (§6.3): with onAuthExpired, call it once for this
     * refusal — a string re-resumes at once, null ends the flow
     * (`Invalid token`), a throw re-tries after the backoff. Without the hook,
     * wait for setAccessToken() to change the token.
     */
    private onTokenRefused(): void {
        const host = this.host;

        if (!host?.hasAuthHook()) {
            this.awaitingTokenOther = host?.identity().accessToken ?? '';
            return;
        }

        const epoch = this.socketEpoch;

        host.refreshAccessToken().then(
            (token) => {
                if (epoch !== this.socketEpoch || this.ready) {
                    return;
                }

                if (typeof token === 'string' && token.length > 0) {
                    this.sendResume();
                    return;
                }

                this.giveUpResume(new ConnectionLostError(CONNECTION_LOST_TEXT.INVALID_TOKEN, { code: 'E3002' }));
            },
            (err: unknown) => {
                if (epoch !== this.socketEpoch || this.ready) {
                    return;
                }

                const delay = reconnectDelayMs(this.refusals);
                const message = err instanceof Error ? err.message : String(err);

                this.emitSystem(`token refresh failed (${message}) — retrying the resume in ${(delay / 1000).toFixed(1)} s`);
                this.resumeTimer = setTimeout(() => {
                    this.resumeTimer = null;
                    if (epoch === this.socketEpoch) {
                        this.sendResume();
                    }
                }, delay);
            }
        );
    }

    // ------------------------------------------------------------ liveness

    /**
     * While a run is active on a protocol-2 relay (it answers every ping
     * with a pong), or a resume awaits its answer, 15 s with no inbound frame
     * means a dead socket: close it with 4000 and reconnect.
     */
    private startLiveness(): void {
        this.stopLiveness();
        this.activeSince = null;

        this.livenessTimer = setInterval(() => {
            const watched =
                this.resumeInFlight ||
                (this.ready && (this.bound?.protocol ?? 1) >= 2 && this.host?.flowActive() === true);

            if (!watched) {
                this.activeSince = null;
                return;
            }

            const now = Date.now();

            if (this.activeSince === null) {
                this.activeSince = now;
            }

            if (now - Math.max(this.lastInboundAt, this.activeSince) >= CHAT_SETTINGS.LIVENESS_MS) {
                this.emitSystem(`no frame for ${CHAT_SETTINGS.LIVENESS_MS / 1000} s while a run is active — closing the socket`);
                this.forceClose(4000, 'liveness');
            }
        }, 1_000);
    }

    private stopLiveness(): void {
        if (this.livenessTimer !== null) {
            clearInterval(this.livenessTimer);
            this.livenessTimer = null;
        }
    }

    private clearTimers(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.resumeTimer) {
            clearTimeout(this.resumeTimer);
            this.resumeTimer = null;
        }
    }

    // ------------------------------------------------------------ helpers

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
     * Reset welcome state so a subsequent socket waits for a fresh welcome
     * (new connection = new cid).
     */
    private resetWelcome(): void {
        this.correlationID = null;
        this.bound = null;
        this.runSentOnCid = false;
        this.welcomePromise = this.makeWelcomePromise();
    }

    private makeWelcomePromise(): Promise<string> {
        return new Promise<string>((resolve) => {
            this.welcomeResolver = resolve;
        });
    }
}
