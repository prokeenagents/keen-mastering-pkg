import ResponseAPI from './response';
import SendRequest, { type ExecuteOptions } from './send-request';
import { CHAT_SETTINGS } from './settings';
import TaskQueue from './task-queue';
import WSConnectAPI from './connect';

/**
 * ChatAPI — THE chat client front door.
 *
 * Consumers (App, tests, future SDKs) should depend only on this
 * class. Everything WS / response routing / retry-related is
 * encapsulated here; the sub-apis are kept as readonly fields for
 * advanced composition (e.g. building TaskQueue on top) but App-level
 * code should not reach into them.
 *
 * Lifecycle:
 *   const chat = new ChatAPI('ws://...');
 *   chat.onStatus(s => ...);
 *   chat.onResponse((env, requestId) => ...);
 *   chat.onStream((event, data) => ...);
 *   chat.onSystem(text => ...);
 *
 *   chat.connect();
 *   const requestId = await chat.send('hello');                 // initial prompt
 *   const envelope  = await chat.waitFor(requestId);            // matching reply
 *
 *   // TaskQueue uses the per-node path:
 *   const nodeRequestId = await chat.sendNodeTask(payload, { maxRetries: Infinity });
 *
 *   chat.sendCancel(correlationID);                              // terminate whole flow
 *   chat.disconnect();
 */
export default class ChatAPI {
    readonly wsConnectApi: WSConnectAPI;
    readonly responseApi: ResponseAPI;
    readonly sendRequestApi: SendRequest;
    readonly taskQueue: TaskQueue;

    readonly spaceID: string;
    readonly agentID: string;
    readonly userId: string;
    readonly email: string;
    readonly projectID: string;
    /**
     * Bearer used inside every run/continuation payload's userContext.
     * NOT readonly: the relay verifies it per-frame, so a token refresh
     * (or, in the harness, editing the token field) must take effect on
     * the NEXT send WITHOUT tearing down the socket. Update via
     * setAccessToken(); all task-queue frames read this live value.
     */
    accessToken: string;
    /**
     * Cookies forwarded to script nodes on the initial run (read via
     * system/cookies). A list of NAMES filters the browser's document.cookie
     * (browser-only — a no-op in headless Node); an explicit { name: value }
     * MAP is used AS-IS with no browser — THIS is how a building agent running
     * via the CLI supplies a cookie a real user's browser would carry (run.ts
     * builds it from --cookie name=value / KEEN_COOKIES). See ChatAPIOptions.cookies.
     */
    readonly cookieConfig?: readonly string[] | Record<string, string>;
    /**
     * Max parallelContext clones drained per wave. Undefined ⇒ the SDK default
     * (CHAT_SETTINGS.CONTEXT_BATCH_SIZE). Only a positive integer is honoured —
     * anything else is dropped here so TaskQueue falls back to the default (a
     * non-positive batch would stall the fan-out loop). See ChatAPIOptions.contextBatchSize.
     */
    readonly contextBatchSize?: number;

    constructor(options: App.Chat.ChatAPIOptions) {
        this.spaceID = options.spaceID;
        this.agentID = options.agentID;
        this.userId = options.userId;
        this.email = options.email;
        // Space id === project id — default projectID to spaceID when the caller
        // doesn't pass one, so a run only has to name the space.
        this.projectID = options.projectID ?? options.spaceID;
        this.accessToken = options.accessToken;
        this.cookieConfig = options.cookies;
        this.contextBatchSize =
            typeof options.contextBatchSize === 'number' && Number.isInteger(options.contextBatchSize) && options.contextBatchSize > 0
                ? options.contextBatchSize
                : undefined;
        this.responseApi = new ResponseAPI();
        // url defaults to the SDK's configured relay endpoint (CHAT_SETTINGS.WS_URL);
        // pass options.url only to point at a different relay per deployment.
        this.wsConnectApi = new WSConnectAPI(options.url ?? CHAT_SETTINGS.WS_URL, this.responseApi);
        this.sendRequestApi = new SendRequest(this.wsConnectApi);
        this.taskQueue = new TaskQueue(this);
    }

    /**
     * Run a flow through the full state machine — sends the initial
     * prompt, receives the root FlowTaskBundle, drives every node
     * (sequential + parallelFlowTask + parallelContextTask) to
     * completion, returns the final bundle map. Throws on any
     * node-level error or cancellation.
     *
     * `chatId` is REQUIRED — every chat row in the chat_history DB is
     * keyed by it. Everything else (userId / email / projectId / agentId)
     * defaults to the ChatAPI constructor's values; pass an override
     * field on the input to use a different identity for this run.
     */
    runFlow(input: App.Chat.RunFlowInput): Promise<ReadonlyMap<string, App.Chat.FlowTaskBundle>> {
        return this.taskQueue.run(input);
    }

    /**
     * Replace the access_token used on subsequent run/continuation
     * frames, without reconnecting. The WS transport carries no auth,
     * so the live socket is unaffected — the new token simply rides the
     * next payload's userContext. Use this to apply a refreshed token
     * mid-session (relay rejects with E3002 when the current one expires).
     */
    setAccessToken(accessToken: string): void {
        this.accessToken = accessToken;
    }

    /**
     * Open the underlying WebSocket. No-op if already opened — call
     * disconnect() first if you need to reconnect.
     *
     * The transport carries no auth. The access_token is sent INSIDE
     * the initial run payload (see runFlow → InitialRunPayload). The
     * engine validates it once on the initial run and returns a
     * correlationToken; every subsequent per-node call carries that
     * server-derived token instead of the access_token, so the user's
     * long-lived credential never crosses the wire after the first
     * request.
     */
    connect(): void {
        this.wsConnectApi.connect();
    }

    /**
     * Close the WebSocket and dispose pending response waiters.
     * Pending waitFor promises reject with a clear error so callers
     * do not hang past the lifetime of the connection.
     */
    disconnect(): void {
        this.wsConnectApi.disconnect();
        this.responseApi.dispose();
    }

    isConnected(): boolean {
        return this.wsConnectApi.isConnected();
    }

    getStatus(): App.Chat.ConnectStatus {
        return this.wsConnectApi.getStatus();
    }

    getUrl(): string {
        return this.wsConnectApi.getUrl();
    }

    /**
     * The connection-scoped correlationID — assigned by relay via
     * the 'welcome' frame and stable for the WS lifetime. Returns
     * null until the welcome has arrived.
     */
    getCorrelationID(): string | null {
        return this.wsConnectApi.getCorrelationID();
    }

    /**
     * Resolve with the correlationID once relay's welcome frame has
     * arrived. TaskQueue / runFlow use this to gate the initial send
     * on the connection being fully established.
     */
    whenReady(): Promise<string> {
        return this.wsConnectApi.whenReady();
    }

    /**
     * Register a correlationID on the connection. Used by TaskQueue
     * when no welcome arrived from relay — TaskQueue mints a fallback
     * cid and stores it here so it becomes the canonical cid for
     * sendCancel and any later flows on this connection.
     */
    setCorrelationID(cid: string): void {
        this.wsConnectApi.setCorrelationID(cid);
    }

    onWelcome(handler: App.Chat.WelcomeHandler): App.Chat.Unsubscribe {
        return this.wsConnectApi.onWelcome(handler);
    }

    /**
     * Fire an INITIAL prompt — wraps it in InitialRunPayload and
     * sends with bounded retries (10 attempts, 1s delay). The matching
     * response envelope (carrying the initial FlowTaskBundle) arrives
     * via onResponse subscribers OR can be awaited via waitFor.
     *
     * Throws if all retries fail.
     */
    async send(input: App.Chat.InitialRunPayload): Promise<string> {
        const sent = await this.sendRequestApi.execute(input, { maxRetries: CHAT_SETTINGS.INITIAL_MAX_RETRIES });

        if (!sent.ok) {
            throw new Error(sent.error);
        }

        return sent.requestId;
    }

    /**
     * Fire a per-node continuation request. Used by TaskQueue for
     * every NodeTask after the initial FlowTask. Default retry policy
     * is INFINITE (1s delay) because the flow is already alive on the
     * server — we keep trying until the socket recovers. Caller can
     * override by passing opts.maxRetries.
     *
     * Throws if all retries fail (only relevant when caller overrode
     * maxRetries to a finite value).
     */
    async sendNodeTask(payload: App.Chat.NodeTaskRequest, opts?: ExecuteOptions): Promise<string> {
        const sent = await this.sendRequestApi.execute(payload, {
            maxRetries: opts?.maxRetries ?? Number.POSITIVE_INFINITY
        });

        if (!sent.ok) {
            throw new Error(sent.error);
        }

        return sent.requestId;
    }

    /**
     * Fire one copy of a parallelContextTask fan-out. The server
     * resolves the entry, mints a brand-new FlowTask scoped to
     * { correlationID, sessionID, options.context } and returns it as
     * the response envelope. Default retry policy is INFINITE — the
     * flow is already alive on the server, just waiting for capacity.
     */
    async sendContextRun(payload: App.Chat.ContextRunPayload, opts?: ExecuteOptions): Promise<string> {
        const sent = await this.sendRequestApi.execute(payload, {
            maxRetries: opts?.maxRetries ?? Number.POSITIVE_INFINITY
        });

        if (!sent.ok) {
            throw new Error(sent.error);
        }

        return sent.requestId;
    }

    /**
     * Fire a prompt and await the matching response envelope. The
     * synchronous-feeling counterpart to send() + waitFor — useful
     * for callers that want one method to cover round-trip semantics
     * (e.g. simple chat without going through TaskQueue).
     */
    sendMessage = async (input: App.Chat.InitialRunPayload): Promise<App.Chat.Envelope> => {
        const requestId = await this.send(input);

        return this.responseApi.waitFor(requestId);
    };

    /**
     * Await the matching response envelope for a previously-sent
     * requestId. TaskQueue calls this directly after sendNodeTask so
     * it can pair the per-node send with the per-node reply.
     */
    waitFor(requestId: string, timeoutMs?: number): Promise<App.Chat.Envelope> {
        return this.responseApi.waitFor(requestId, timeoutMs);
    }

    /**
     * Cancel the currently running flow. Stops the TaskQueue drain
     * loop, sends the cancel frame to relay (which forwards to engine
     * to wipe dict / session / agentState / queue for this cid), and
     * clears local bundle state. Safe to call when no flow is running
     * (idempotent). This is the consumer-facing cancel entry point.
     */
    cancel(): void {
        this.taskQueue.cancel();
    }

    /**
     * Subscribe to flow-in-flight transitions. Fires `true` when a
     * runFlow starts and `false` when it settles (success / throw /
     * cancel). Pair with onStatus for the canonical Send-button gate:
     *   canSend = (status === 'connected' && !running)
     */
    onRunning(handler: App.Chat.RunningHandler): App.Chat.Unsubscribe {
        return this.taskQueue.onRunning(handler);
    }

    /**
     * Synchronous snapshot of the in-flight flag. True while a runFlow
     * is executing; false otherwise.
     */
    isRunning(): boolean {
        return this.taskQueue.isRunning();
    }

    /**
     * Low-level: fire just the cancel frame, no local cleanup. Used
     * internally by TaskQueue.cancel and TaskQueue.run's failure
     * cleanup path. Consumer code should call chat.cancel() instead —
     * calling sendCancel without going through the TaskQueue leaves
     * the local drain loop running.
     */
    sendCancel(correlationID?: string): boolean {
        const cid = correlationID ?? this.getCorrelationID();

        if (!cid) {
            return false;
        }

        const frame: App.Chat.OutboundFrame = {
            event: 'cancel',
            data: { correlationId: cid }
        };

        return this.wsConnectApi.sendFrame(frame);
    }

    /**
     * Fire a heartbeat ping. Relay derives the cid from the WebSocket
     * itself; no payload. TaskQueue calls this every ~20s while a run
     * is in flight so the engine's dict / session TTLs stay fresh
     * across idle gaps between per-node calls. Returns false if the
     * socket is not open — caller decides whether to retry.
     */
    sendPing(): boolean {
        const frame: App.Chat.OutboundFrame = {
            event: 'ping',
            data: {}
        };

        return this.wsConnectApi.sendFrame(frame);
    }

    onStatus(handler: App.Chat.StatusHandler): App.Chat.Unsubscribe {
        return this.wsConnectApi.onStatus(handler);
    }

    onSystem(handler: App.Chat.SystemHandler): App.Chat.Unsubscribe {
        return this.wsConnectApi.onSystem(handler);
    }

    onResponse(handler: App.Chat.ResponseHandler): App.Chat.Unsubscribe {
        return this.responseApi.onResponse(handler);
    }

    onStream(handler: App.Chat.StreamEventHandler): App.Chat.Unsubscribe {
        return this.responseApi.onStream(handler);
    }
}
