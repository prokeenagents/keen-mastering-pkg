import type ChatAPI from './index';
import { CHAT_SETTINGS } from './settings';
import { FatalSendError, generateRequestId, generateUUID, resolveRequestCookies, sleep } from './utils';

type NodeTask = App.Chat.NodeTask;
type FlowTaskBundle = App.Chat.FlowTaskBundle;
type InitialRunPayload = App.Chat.InitialRunPayload;
type RunFlowInput = App.Chat.RunFlowInput;
type NodeTaskRequest = App.Chat.NodeTaskRequest;
type FlowUpdateHandler = App.Chat.FlowUpdateHandler;
type RunningHandler = App.Chat.RunningHandler;
type Unsubscribe = App.Chat.Unsubscribe;

/**
 * The key under which a bundle lives in TaskQueue's map. Built from
 * the three identity fields together so a single flow tree can have
 * many bundles (root + parallelFlowTask siblings + parallelContextTask
 * copies) without flowId collisions.
 */
function bundleKey(flow: { correlationId: string; sessionId: string; flowId: string }): string {
    return `${flow.correlationId}_${flow.sessionId}_${flow.flowId}`;
}

/**
 * TaskQueue — drives one chat's flow from the initial prompt to a
 * terminal state across an arbitrary tree of bundles. One TaskQueue
 * per ChatAPI instance; each new chat session gets its own.
 *
 * State shape:
 *   Map<`${correlationId}_${sessionId}_${flowId}`, FlowTaskBundle>
 * Every bundle in the tree lives here — root, parallelFlowTask
 * siblings, parallelContextTask copies. Parallel-host nodes are
 * normalised to Array<string> referencing bundle keys, so the tree
 * structure stays flat on the client side.
 *
 * Lifecycle of run({ agentId, prompt }):
 *   1. chat.send({...}) → requestId
 *   2. chat.waitFor(requestId) → envelope carrying root FlowTaskBundle
 *   3. registerBundle(root)
 *   4. drainBundle(root) — scan-and-fire pending nodes until none remain
 *   5. while any bundle in the map has flowContext.completed:false, keep draining
 *   6. resolve with the full bundle map (frozen view)
 *   7. clear() — empty the map, next run starts fresh
 *
 * Cancellation:
 *   - cancel() sets cancelled flag, fires chat.sendCancel(correlationId)
 *     once (one signal covers the whole tree because all bundles share
 *     the same correlationId), then clear()s locally.
 *   - any in-flight node processing checks the flag at every await
 *     boundary and bails out.
 */
export default class TaskQueue {
    private readonly bundles = new Map<string, FlowTaskBundle>();
    private cancelled = false;
    private rootCorrelationId: string | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private running = false;

    private readonly updateHandlers = new Set<FlowUpdateHandler>();
    private readonly runningHandlers = new Set<RunningHandler>();

    constructor(private readonly chat: ChatAPI) {}

    /**
     * Send the initial prompt, receive the root bundle, drive every
     * bundle in the tree to completion. Returns a readonly snapshot of
     * the final bundle map. Throws on any send / node error or cancel.
     *
     * The three identity fields (correlationId, sessionId, requestId)
     * are minted here BEFORE the initial frame goes out — client owns
     * the flow's identity from the very first byte on the wire. The
     * server's response echoes these IDs so the bundle key
     * `${correlationId}_${sessionId}_${flowId}` is stable across the
     * round trip.
     */
    async run(input: RunFlowInput): Promise<ReadonlyMap<string, FlowTaskBundle>> {
        if (this.bundles.size > 0) {
            throw new Error('TaskQueue already running — call clear() or cancel() first');
        }

        this.cancelled = false;
        this.rootCorrelationId = null;

        /**
         * correlationId is connection-scoped — relay assigns it via a
         * 'welcome' frame on WS open. Until that relay change ships,
         * fall back to a client-minted cid so dev isn't blocked, and
         * register it on the connection so sendCancel + later flows
         * see the same value.
         */
        let correlationId = this.chat.getCorrelationID();

        if (!correlationId) {
            correlationId = generateRequestId();
            this.chat.setCorrelationID(correlationId);
        }

        /**
         * Start the heartbeat as soon as the cid is known and stop it
         * in finally — covers the success path, normal early returns,
         * and every throw / cancel exit. The heartbeat is what keeps
         * the engine's dict / session TTLs refreshed while the flow
         * sits idle between per-node calls (slow LLM, queued upstream
         * call, etc.).
         *
         * setRunning(true) fires onRunning(true) for consumers gating
         * UI on "is a flow in flight". Paired with setRunning(false)
         * in the outer finally so it flips back regardless of exit
         * path (success, throw, cancel).
         */
        this.setRunning(true);
        this.startHeartbeat();

        try {
            /**
             * Single failure-cleanup boundary for the whole flow.
             *
             * Any throw — initial-run transport exhaustion, initial
             * waitFor timeout, non-success initial envelope, per-node
             * max-retries-exceeded, terminal node error, parallel
             * fan-out failure — funnels through one catch that:
             *
             *   1. Fires sendCancel() so FlowCancelMgr wipes every
             *      server-side entry under the cid (dict, session,
             *      agentState, work queue). Idempotent — if nothing
             *      was created on the engine side, deletes no-op.
             *   2. Clears the local bundle map so a subsequent
             *      runFlow() doesn't reject with "already running".
             *
             * Skipped when the user already triggered cancel() — that
             * path fires sendCancel itself, and double-firing buys
             * nothing.
             */
            try {
                const payload: InitialRunPayload = {
                    userContext: {
                        userId: input.userId ?? this.chat.userId,
                        email: input.email ?? this.chat.email,
                        accessToken: this.chat.accessToken
                    },
                    rootAgentContext: {
                        agentId: input.agentId ?? this.chat.agentID,
                        prompt: input.prompt
                    },
                    chatContext: {
                        chatId: input.chatId,
                        projectId: input.projectId ?? this.chat.projectID
                    },
                    flowContext: {
                        correlationId,
                        sessionId: generateRequestId(),
                        requestId: generateRequestId()
                    },
                    /**
                     * Request-scoped cookies the consumer carried in (e.g. a
                     * Google-Connect token). Read from document.cookie at
                     * send time and forwarded ONLY on the initial run — the
                     * engine writes them to cookieStorage:${cid}_${sid} once;
                     * script nodes read them via system/cookies. (Browser JS
                     * can't see HttpOnly cookies — those won't appear here.)
                     */
                    requestContext: {
                        cookies: resolveRequestCookies(this.chat.cookieConfig)
                    }
                };

                const requestId = await this.chat.send(payload);
                const envelope = await this.chat.waitFor(requestId);

                if (this.cancelled) {
                    throw new Error('TaskQueue cancelled');
                }

                if (!envelope.success) {
                    throw new Error(envelope.message ?? envelope.code);
                }

                const root = this.normaliseInboundBundle(envelope.data);

                /**
                 * Defensive: spec says "if the server returns something
                 * that does not have nodeTasks, finish the chain
                 * operation."
                 */
                if (!root?.nodeTasks || root.nodeTasks.length === 0) {
                    if (root?.flowTask) {
                        root.flowTask.flowContext.completed = true;
                        this.registerBundle(root);
                    }

                    return this.snapshotAndClear();
                }

                this.rootCorrelationId = root.flowTask.flowContext.correlationId;
                this.registerBundle(root);

                /**
                 * Drain until every bundle in the map is completed. Each
                 * iteration drains every still-not-completed bundle in
                 * parallel; freshly registered bundles (from parallel
                 * normalisation) get picked up on the next pass.
                 */
                while (!this.cancelled && this.hasIncomplete()) {
                    const incompletes = Array.from(this.bundles.values()).filter(
                        (b) => !b.flowTask.flowContext.completed
                    );

                    await Promise.all(incompletes.map((b) => this.drainBundle(b)));
                }

                if (this.cancelled) {
                    throw new Error('TaskQueue cancelled');
                }

                return this.snapshotAndClear();
            } catch (err) {
                if (!this.cancelled) {
                    this.chat.sendCancel();
                }

                this.clear();
                throw err;
            }
        } finally {
            this.stopHeartbeat();
            this.setRunning(false);
        }
    }

    /**
     * Cancel the current run. Sends sendCancel to the server (one
     * signal covers the whole tree because all bundles share the
     * correlationId) and wipes local state. Safe to call when idle.
     */
    cancel(): void {
        this.cancelled = true;

        if (this.rootCorrelationId) {
            this.chat.sendCancel(this.rootCorrelationId);
        }

        this.clear();
    }

    /**
     * Reset the collector. Used internally at the end of run() and
     * externally by callers who want a clean slate without sending a
     * cancel.
     */
    clear(): void {
        this.bundles.clear();
        this.rootCorrelationId = null;
        this.emitUpdate();
    }

    /**
     * Read-only snapshot of the current bundle map. UI components
     * subscribe via onUpdate; this is the fallback for callers that
     * want a one-shot read.
     */
    getBundles(): ReadonlyMap<string, FlowTaskBundle> {
        return this.bundles;
    }

    isActive(): boolean {
        return this.bundles.size > 0;
    }

    onUpdate(handler: FlowUpdateHandler): Unsubscribe {
        this.updateHandlers.add(handler);

        return () => {
            this.updateHandlers.delete(handler);
        };
    }

    /**
     * Subscribe to flow in-flight transitions. Fires `true` when run()
     * starts, `false` when it settles. Idempotent: re-emitting the same
     * value is a no-op (no duplicate transitions).
     */
    onRunning(handler: RunningHandler): Unsubscribe {
        this.runningHandlers.add(handler);

        return () => {
            this.runningHandlers.delete(handler);
        };
    }

    /**
     * Synchronous snapshot of the in-flight flag. True between the start
     * of run() and the end of its finally; false otherwise.
     */
    isRunning(): boolean {
        return this.running;
    }

    /**
     * Drain pending nodes from one bundle until all are ready. Scans
     * for !inProgress && !ready, fires them in parallel via
     * processNode, repeats. Once no pending remain we mark the
     * bundle's flowContext.completed = true so the outer run() loop
     * stops re-visiting it.
     */
    private async drainBundle(bundle: FlowTaskBundle): Promise<void> {
        if (bundle.flowTask.flowContext.completed || this.cancelled) {
            return;
        }

        while (!this.cancelled) {
            const pending = bundle.nodeTasks.filter((n) => !n.inProgress && !n.ready);

            if (pending.length === 0) {
                break;
            }

            await Promise.all(pending.map((node) => this.processNode(bundle, node)));
        }

        if (this.cancelled) {
            return;
        }

        /**
         * Once a bundle has nothing more to drain locally, check
         * whether its parallel-host nodes are still waiting on child
         * bundles. If any child is not yet completed, this bundle is
         * NOT completed yet — the outer run() loop will come back to
         * it after the children's drain has finished.
         */
        if (this.allParallelDependenciesReady(bundle)) {
            bundle.flowTask.flowContext.completed = true;
            this.emitUpdate();
        }
    }

    /**
     * Drive one NodeTask:
     *   - normalise parallelFlowTask (incoming Array<bundle>) into
     *     Array<string> ids, register each bundle
     *   - normalise parallelContextTask (incoming { flowTask, total })
     *     into Array<string> ids, registering N cloned bundles
     *   - otherwise send the per-node request, await response, push
     *     server's nextNodeTasks onto the bundle
     */
    private async processNode(bundle: FlowTaskBundle, node: NodeTask): Promise<void> {
        if (this.cancelled || node.ready || node.inProgress) {
            return;
        }

        node.inProgress = true;
        this.emitUpdate();

        try {
            if (this.isInboundParallelFlowTask(node.parallelFlowTask)) {
                await this.normaliseParallelFlowTask(node);
                return;
            }

            if (this.isInboundParallelContextTask(node.parallelContextTask)) {
                await this.normaliseParallelContextTask(bundle, node);
                return;
            }

            /**
             * If the node is still waiting on already-registered child
             * bundles (parallel hosts that were normalised on a prior
             * pass), don't fire a per-node send — just check whether
             * the children are done.
             */
            if (this.isNormalisedParallelHost(node)) {
                this.maybeMarkParallelHostReady(node);
                return;
            }

            await this.runRegularNode(bundle, node);
        } finally {
            if (!node.ready) {
                node.inProgress = false;
                this.emitUpdate();
            }
        }
    }

    private async runRegularNode(bundle: FlowTaskBundle, node: NodeTask): Promise<void> {
        const flow = bundle.flowTask;
        const fc = flow.flowContext;

        /**
         * Build the per-call flowContext for the wire. Always carries
         * correlationId / sessionId / requestId from this bundle.
         * flowId is included only for non-root bundles — the root
         * flow's flowId lives on rootFlowContext.flowId and the engine
         * reads it from there. Spawn metadata (parentFlowId /
         * parentSessionId / contextNumber / contextPath /
         * correlationToken) flows through verbatim from the bundle's
         * flowContext when present.
         */
        const isRoot = bundle.flowTask.rootFlowContext.flowId === fc.flowId
            && !fc.parentFlowId
            && fc.contextNumber === undefined;

        const outgoingFlowContext: App.Chat.FlowContext = {
            correlationId: fc.correlationId,
            sessionId: fc.sessionId,
            requestId: fc.requestId,
            ...(isRoot ? {} : { flowId: fc.flowId }),
            /**
             * currentFlowId = the dict-owning flow. A runFlow/jumpFlow child
             * inherits its spawner's currentFlowId (set engine-side), so it
             * stays on the calling flow's dict (e.g. a clone's dict) instead of
             * snapping back to the tree root. Forward it on every per-node call.
             */
            ...(fc.currentFlowId ? { currentFlowId: fc.currentFlowId } : {}),
            ...(fc.parentFlowId ? { parentFlowId: fc.parentFlowId } : {}),
            /**
             * parentSessionId signals to the engine "use the parent's
             * sessionId for the session-storage key, not this flow's
             * own". Set only on parallel siblings (where the spawning
             * engine code copies parent.sessionId into the sibling's
             * parentSessionId); root flows + context clones omit it.
             */
            ...(fc.parentSessionId ? { parentSessionId: fc.parentSessionId } : {}),
            /**
             * parallelContext clone coordinates. The engine stamps
             * contextNumber + contextPath onto the clone's bundle
             * flowContext; we forward them on EVERY per-node call so
             * the engine's dict seam (key-by-flowId + seed + merge) fires
             * for the clone's whole lifetime. Absent on non-context flows.
             */
            ...(typeof fc.contextNumber === 'number'
                ? {
                      contextNumber: fc.contextNumber,
                      contextPath: typeof fc.contextPath === 'string' ? fc.contextPath : ''
                  }
                : {}),
            /**
             * Engine populates correlationToken in the initial
             * bundle's flowContext once auth lands; until then it's
             * undefined and the server-side hash check is skipped.
             * Spreading via the optional field keeps the payload absent
             * the prop entirely when there's nothing to send.
             */
            ...(fc.correlationToken ? { correlationToken: fc.correlationToken } : {})
        };

        const payload: NodeTaskRequest = {
            /**
             * Re-stamp the access_token on EVERY outbound run frame. The
             * relay verifies userContext.accessToken per message (not just
             * the initial run), and the server-echoed userContext on
             * continuations/children does not carry it.
             */
            userContext: { ...flow.userContext, accessToken: this.chat.accessToken },
            rootFlowContext: flow.rootFlowContext,
            chatContext: flow.chatContext,
            flowContext: outgoingFlowContext,
            nodeContext: {
                id: node.nodeContext.id,
                kind: node.nodeContext.kind,
                ...(node.nodeContext.initial !== undefined ? { initial: node.nodeContext.initial } : {})
            },
            /**
             * Per-call side-band. Polymorphic:
             *   - agentNode redispatch after a tool: `{ toolResponse:
             *     true, promptMarker }` (emitted by the engine).
             *   - inside a tool flow: `{ toolContext, agentNode }`
             *     auto-propagated by the engine (flow tools) OR
             *     seeded here from `flow.options` (script tools'
             *     virtualScriptNode, which goes directly to
             *     the script engine with no auto-propagation
             *     hop in between).
             *
             * Rule: `node.options` (explicit) wins. Otherwise for any
             * nodeTask in a `toolFlow:true` bundle, seed from
             * `flow.options` regardless of `initial` — the script-tool
             * childFlow's only node is `initial:false` per the wire
             * spec, but still needs the options pack.
             */
            ...(((): { options?: Record<string, unknown> } => {
                const explicit = node.options as Record<string, unknown> | undefined;
                if (explicit) {
                    return { options: explicit };
                }
                if (flow.toolFlow && flow.options) {
                    return { options: flow.options as Record<string, unknown> };
                }
                return {};
            })())
        };

        /**
         * Two layers of retry:
         *   1. Transport retry — handled inside SendRequest (socket not
         *      ready → 1s backoff, max 10 for initial nodes, Infinity
         *      for continuations).
         *   2. Response retry — THIS loop. When the server replies with
         *      a non-success envelope whose code is not terminal
         *      (E2x, E3x, E8x), we wait 1s and re-issue the whole
         *      send + waitFor cycle. Max attempts mirrors the
         *      transport policy: bounded for initial, infinite for
         *      continuations.
         */
        const maxResponseRetries = node.nodeContext.initial ? CHAT_SETTINGS.INITIAL_MAX_RETRIES : Number.POSITIVE_INFINITY;
        let attempt = 0;
        let lastError: string | null = null;

        while (attempt < maxResponseRetries) {
            attempt += 1;

            if (this.cancelled) {
                return;
            }

            /**
             * Send + waitFor live inside the same try so transport
             * exhaustion, waitFor timeout, and connection drop all hit
             * the catch and feed the retry loop — same policy as a
             * non-success envelope. Without this, a waitFor timeout
             * for a non-initial node escapes the loop entirely and
             * kills the flow despite maxResponseRetries = Infinity.
             */
            let envelope: App.Chat.Envelope;
            try {
                const requestId = await this.chat.sendNodeTask(payload, {
                    maxRetries: node.nodeContext.initial ? CHAT_SETTINGS.INITIAL_MAX_RETRIES : Number.POSITIVE_INFINITY
                });

                if (this.cancelled) {
                    return;
                }

                envelope = await this.chat.waitFor(requestId);
            } catch (err) {
                if (this.cancelled) {
                    return;
                }

                /**
                 * A NON-retryable failure — an undeliverable oversized frame —
                 * fails identically on every attempt, so retrying (with an
                 * infinite budget for a continuation) would loop forever. Re-throw
                 * it straight through the drain to the run() catch, which cancels
                 * the cid and settles runFlow with this reason.
                 */
                if (err instanceof FatalSendError) {
                    throw err;
                }

                lastError = err instanceof Error ? err.message : String(err);

                if (attempt < maxResponseRetries) {
                    await sleep(CHAT_SETTINGS.RETRY_DELAY_MS);
                    continue;
                }

                throw new Error(`max response retries exceeded for node ${node.nodeContext.id}; last error: ${lastError}`);
            }

            if (this.cancelled) {
                return;
            }

            // Stamp THIS node with its own response so the harness inspector
            // can show the exact per-node request/response on click.
            node.response = envelope;

            if (envelope.success) {
                /**
                 * End-of-flow signal: the engine's EndNode replies with
                 *   { final: true, flowContext: { flowId, correlationId, sessionId, requestId } }
                 * where the four ids match THIS bundle's flowContext. That
                 * means "this bundle is done — no further nodes will
                 * come, mark it completed immediately."
                 *
                 * The id match doubles as an integrity check: if a
                 * `final: true` arrives with ids that don't belong to
                 * this bundle, we treat it as a protocol violation
                 * (logged via emitUpdate channel later, not actioned).
                 */
                if (this.isEndOfFlowSignal(envelope.data, bundle)) {
                    bundle.flowTask.flowContext.completed = true;
                    node.inProgress = false;
                    node.ready = true;
                    /**
                     * virtualEndNode visual entry — client-only. When
                     * a script-tool childFlow (virtualScriptNode) hits
                     * its terminal `{ final: true }` signal, append a
                     * virtualEndNode to the bundle's nodeTasks so the
                     * visualizer renders the full virtualStart →
                     * virtualScript → virtualEnd chain. Never travels
                     * on the wire.
                     */
                    if (node.nodeContext.kind === 'virtualScriptNode') {
                        bundle.nodeTasks.push({
                            flowContext: { ...node.flowContext },
                            nodeContext: { id: `vEnd-${generateUUID()}`, kind: 'virtualEndNode', initial: false },
                            ready: true,
                            inProgress: false,
                            response: envelope
                        });
                    }
                    this.emitUpdate();
                    return;
                }

                /**
                 * Spawned child flows (runFlowNode pattern): the
                 * response carries `childFlows: [...]` — one or more
                 * fresh FlowTaskBundles, each with
                 * flowContext.parentFlowId pointing at THIS bundle's
                 * flowContext.flowId. The node that fired the call
                 * must stay pending until ALL children drain. Marked
                 * via the existing parallelFlowTask normalisation so
                 * maybeMarkParallelHostReady flips this node ready
                 * only when every child has completed.
                 */
                if (this.isSpawnedChildrenResponse(envelope.data, bundle)) {
                    await this.handleSpawnedChildren(bundle, node, envelope.data);
                    return;
                }

                /**
                 * parallelContext fan-out: response carries
                 *   { parallelContextTask: { flowTask: template, total }, nodeTasks?: [...] }
                 * The engine sends ONE template + count (O(1) in N); we
                 * clone it `total` times here and drain in batches of 15
                 * so a huge collection never floods the engine.
                 */
                if (this.isSpawnedContextResponse(envelope.data)) {
                    await this.handleSpawnedContext(bundle, node, envelope.data);
                    return;
                }

                /**
                 * Tolerate four response shapes the server might send:
                 *   1. A single NodeTask              — { flowContext, nodeContext, ... }
                 *   2. NodeTaskResponse               — { nextNodeTasks: [...] }
                 *   3. FlowTaskBundle                 — { flowTask, nodeTasks: [...] }
                 *   4. Bare nodeTasks array carrier   — { nodeTasks: [...] }
                 */
                const incoming = this.extractIncomingNodes(envelope.data);

                /**
                 * Dedup only against PENDING entries — nodes that are
                 * neither in-progress nor already-ready. This catches
                 * a server that re-echoes a currently-queued node
                 * (infinite-loop guard) while still allowing
                 * intentional re-execution via jumpFlowNode (which
                 * legitimately returns a node whose id was already
                 * run earlier in the same bundle's lifetime).
                 *
                 * Each re-entry pushes a FRESH NodeTask entry; the
                 * bundle's nodeTasks array grows by one per iteration
                 * of a loop. The new entry's ready/inProgress are
                 * false (scrubInboundNode) so the drain loop picks it
                 * up immediately.
                 */
                const pendingIds = new Set(
                    bundle.nodeTasks
                        .filter((n) => !n.ready && !n.inProgress)
                        .map((n) => n.nodeContext.id)
                );
                const fresh = incoming.filter((n) => !pendingIds.has(n.nodeContext.id));

                bundle.nodeTasks.push(...fresh);

                node.inProgress = false;
                node.ready = true;
                this.emitUpdate();
                return;
            }

            /**
             * Server error. If the code is a hard-terminal one
             * (bad input, auth failure, explicit cancel) we surface
             * it. Anything else we treat as transient and retry.
             */
            if (this.isTerminalErrorCode(envelope.code)) {
                throw new Error(envelope.message ?? envelope.code);
            }

            lastError = `${envelope.code}: ${envelope.message ?? ''}`;

            if (attempt < maxResponseRetries) {
                await sleep(CHAT_SETTINGS.RETRY_DELAY_MS);
            }
        }

        throw new Error(`max response retries exceeded for node ${node.nodeContext.id}; last error: ${lastError ?? 'unknown'}`);
    }

    /**
     * Codes the server might send that are NOT worth retrying:
     *   E2xxx — client error (bad payload, won't fix itself)
     *   E3xxx — auth failure (won't fix itself)
     *   E8xxx — explicit cancellation (intentionally terminated)
     * Everything else (E4* capacity, E5* resource, E6* system,
     * E7* upstream) is treated as transient and retried.
     */
    private isTerminalErrorCode(code: string | undefined): boolean {
        if (typeof code !== 'string') {
            return false;
        }

        return code.startsWith('E2') || code.startsWith('E3') || code.startsWith('E8');
    }

    /**
     * Detect a spawned-children response (runFlowNode pattern). Shape:
     *   {
     *     childFlows: [ { flowTask, nodeTasks }, ... ]   — one or more sub-flows
     *     nodeTasks?: [...]                              — parent's continuation
     *   }
     *
     * Each `childFlows[i].flowTask.flowContext.parentFlowId` MUST match
     * the bundle that owns the spawning node. We spot-check the first
     * entry as the discriminator; per-entry validation runs in
     * handleSpawnedChildren so a mid-list mismatch surfaces loudly.
     */
    private isSpawnedChildrenResponse(data: unknown, bundle: FlowTaskBundle): boolean {
        if (!data || typeof data !== 'object') {
            return false;
        }

        const obj = data as Record<string, unknown>;
        const childFlows = obj.childFlows;

        if (!Array.isArray(childFlows) || childFlows.length === 0) {
            return false;
        }

        const first = childFlows[0] as Record<string, unknown> | undefined;

        if (!first || typeof first !== 'object') {
            return false;
        }

        const flowTask = first.flowTask as Record<string, unknown> | undefined;

        if (!flowTask || typeof flowTask !== 'object') {
            return false;
        }

        const flowContext = flowTask.flowContext as Record<string, unknown> | undefined;

        if (!flowContext || typeof flowContext !== 'object') {
            return false;
        }

        return flowContext.parentFlowId === bundle.flowTask.flowContext.flowId;
    }

    /**
     * Handle the runFlowNode pattern. Response shape:
     *   {
     *     childFlows: [ { flowTask, nodeTasks }, ... ]    — required
     *     nodeTasks?: [...]                                — parent's continuation
     *   }
     *
     * Sequence:
     *   1. Validate every child's flowContext.parentFlowId matches the bundle.
     *   2. Register all children + attach their keys to the spawning
     *      node via parallelFlowTask so maybeMarkParallelHostReady
     *      flips it ready only when every child completes.
     *   3. Drain all children IN PARALLEL — execution pauses here
     *      until the LAST child's end signal lands.
     *   4. Mark the spawning node ready (all children done).
     *   5. ONLY THEN push the parent's continuation nodes onto the
     *      parent bundle. Pushing earlier would let the parent's next
     *      nodes race the children.
     */
    private async handleSpawnedChildren(bundle: FlowTaskBundle, node: NodeTask, data: unknown): Promise<void> {
        const obj = data as { childFlows?: unknown; nodeTasks?: unknown };
        const childRaw = Array.isArray(obj.childFlows) ? obj.childFlows : [];
        const expectedParent = bundle.flowTask.flowContext.flowId;

        const childBundles: FlowTaskBundle[] = [];

        for (const raw of childRaw) {
            const child = this.normaliseInboundBundle(raw);
            const childParent = child.flowTask.flowContext.parentFlowId;

            if (childParent !== expectedParent) {
                throw new Error(`spawned child parentFlowId ${childParent ?? '(missing)'} does not match parent ${expectedParent}`);
            }

            this.registerBundle(child);
            childBundles.push(child);
        }

        const childKeys = childBundles.map((b) => bundleKey(b.flowTask.flowContext));
        const existing = Array.isArray(node.parallelFlowTask) ? (node.parallelFlowTask as string[]) : [];

        node.parallelFlowTask = [...existing, ...childKeys];
        this.emitUpdate();

        /**
         * Drain every child concurrently. Promise.all settles only
         * when the SLOWEST child finishes — that's the "wait for all"
         * semantic. Any child throwing propagates out (caught by the
         * outer runFlow cleanup catch).
         */
        await Promise.all(childBundles.map((c) => this.drainBundle(c)));

        if (this.cancelled) {
            return;
        }

        this.maybeMarkParallelHostReady(node);

        /**
         * Parent's continuation. Engine ships the parent's next nodes
         * (typically the parent's endNode, or the loop node when a
         * loop's body is a runFlow) alongside the child bundles.
         * Pushed onto the PARENT'S nodeTasks AFTER all children have
         * drained so the parent's drain loop picks them up on its
         * next pass — never racing the children.
         *
         * Dedup ONLY against pending (!ready && !inProgress) entries
         * so a continuation that loops back to a node which already
         * ran (loop iterating via runFlow body, jumpFlow re-entering
         * an earlier node) gets pushed as a FRESH entry instead of
         * being filtered out by a stale completed ghost.
         */
        const parentNext = Array.isArray(obj.nodeTasks) ? (obj.nodeTasks as NodeTask[]).map((n) => this.scrubInboundNode(n)) : [];

        if (parentNext.length > 0) {
            const pendingIds = new Set(
                bundle.nodeTasks
                    .filter((n) => !n.ready && !n.inProgress)
                    .map((n) => n.nodeContext.id)
            );
            const fresh = parentNext.filter((n) => !pendingIds.has(n.nodeContext.id));

            bundle.nodeTasks.push(...fresh);
            this.emitUpdate();
        }
    }

    /**
     * Detect a parallelContext fan-out response: a top-level
     * `parallelContextTask` in its inbound object form
     * `{ flowTask, total }` (not the normalised id-array form).
     */
    private isSpawnedContextResponse(data: unknown): boolean {
        if (!data || typeof data !== 'object') {
            return false;
        }

        const pct = (data as { parallelContextTask?: unknown }).parallelContextTask;

        return Boolean(pct) && typeof pct === 'object' && !Array.isArray(pct) && 'flowTask' in (pct as object) && 'total' in (pct as object);
    }

    /**
     * Handle a parallelContext fan-out. The engine sends ONE template
     * bundle + `total`; we clone it `total` times (cheap small objects),
     * stamping flowContext.contextNumber = index, then drain in SEQUENTIAL
     * BATCHES OF 15 — at most 15 clones in flight at once. The engine's
     * ProcessCoordinator (8) bounds it further, so engine memory stays
     * flat regardless of N (this is what the eager-childFlows shape
     * couldn't guarantee — it was one giant synchronous allocation).
     *
     * Sequence mirrors handleSpawnedChildren: register all, attach keys
     * to the host node (so maybeMarkParallelHostReady flips it ready
     * only when every clone completes), drain, THEN push the parent's
     * next_1 continuation — never racing the clones.
     */
    private async handleSpawnedContext(bundle: FlowTaskBundle, node: NodeTask, data: unknown): Promise<void> {
        const obj = data as { parallelContextTask?: { flowTask: FlowTaskBundle; total: number }; nodeTasks?: unknown };
        const spec = obj.parallelContextTask;

        if (!spec) {
            return;
        }

        const template = spec.flowTask;
        const total = Math.max(0, Math.floor(spec.total));

        const ids: string[] = [];

        for (let index = 0; index < total; index += 1) {
            const clone = this.cloneBundleForContext(bundle, template, index);

            this.registerBundle(clone);
            ids.push(bundleKey(clone.flowTask.flowContext));
        }

        node.parallelContextTask = ids;
        this.emitUpdate();

        /**
         * Drain in SEQUENTIAL batches of 15 — fire 15, wait until all 15
         * have fully drained, then the next 15, until every clone is
         * done. NEVER fires all N at once (a 10k-context fan-out would
         * bombard the engine). 15 < the engine's 33 admission slots, so
         * a single fan-out won't self-reject. `completed` counts so
         * "1000 of 1000 ready" is observable.
         */
        const BATCH = this.chat.contextBatchSize ?? CHAT_SETTINGS.CONTEXT_BATCH_SIZE;
        let completed = 0;

        for (let start = 0; start < ids.length; start += BATCH) {
            if (this.cancelled) {
                return;
            }

            const batch = ids
                .slice(start, start + BATCH)
                .map((id) => this.bundles.get(id))
                .filter((b): b is FlowTaskBundle => Boolean(b));

            await Promise.all(batch.map((b) => this.drainBundle(b)));

            completed += batch.length;
            console.log(`[parallelContext] ${completed}/${ids.length} contexts ready`);
        }

        if (this.cancelled) {
            return;
        }

        this.maybeMarkParallelHostReady(node);

        const parentNext = Array.isArray(obj.nodeTasks) ? (obj.nodeTasks as NodeTask[]).map((n) => this.scrubInboundNode(n)) : [];

        if (parentNext.length > 0) {
            const pendingIds = new Set(
                bundle.nodeTasks
                    .filter((n) => !n.ready && !n.inProgress)
                    .map((n) => n.nodeContext.id)
            );
            const fresh = parentNext.filter((n) => !pendingIds.has(n.nodeContext.id));

            bundle.nodeTasks.push(...fresh);
            this.emitUpdate();
        }
    }

    /**
     * Detect the EndNode terminator. Engine replies with
     *   { final: true, flowContext: { flowId, correlationId, sessionId, requestId } }
     * where the four ids match the bundle's own flowContext. The id
     * match is an integrity check — a `final: true` with mismatched
     * ids would mean the engine misrouted the terminator, so we
     * refuse to act on it (the bundle would never naturally complete
     * but at least we don't mark the wrong bundle done).
     */
    private isEndOfFlowSignal(data: unknown, bundle: FlowTaskBundle): boolean {
        if (!data || typeof data !== 'object') {
            return false;
        }

        const obj = data as Record<string, unknown>;

        if (obj.final !== true) {
            return false;
        }

        const incomingFc = obj.flowContext as Record<string, unknown> | undefined;

        if (!incomingFc || typeof incomingFc !== 'object') {
            return false;
        }

        const fc = bundle.flowTask.flowContext;

        return (
            incomingFc.flowId === fc.flowId &&
            incomingFc.correlationId === fc.correlationId &&
            incomingFc.sessionId === fc.sessionId &&
            incomingFc.requestId === fc.requestId
        );
    }

    /**
     * Pull the list of next NodeTasks out of whatever shape the server
     * decided to send. Supports single NodeTask (the spec form),
     * { nextNodeTasks: [...] }, { nodeTasks: [...] }, and the full
     * FlowTaskBundle echo.
     */
    private extractIncomingNodes(data: unknown): NodeTask[] {
        if (!data || typeof data !== 'object') {
            return [];
        }

        const obj = data as Record<string, unknown>;
        let raw: NodeTask[] = [];

        if (Array.isArray(obj.nextNodeTasks)) {
            raw = obj.nextNodeTasks as NodeTask[];
        } else if (Array.isArray(obj.nodeTasks)) {
            raw = obj.nodeTasks as NodeTask[];
        } else if (this.looksLikeSingleNodeTask(obj)) {
            /**
             * Single NodeTask shape — has flowContext + nodeContext but
             * no nodeTasks/nextNodeTasks arrays. The whole envelope.data
             * IS the next node.
             */
            raw = [data as NodeTask];
        }

        return raw.map((n) => this.scrubInboundNode(n));
    }

    /**
     * True when the object has the wire-shape of a single NodeTask
     * (flowContext + nodeContext both present and object-typed). Used
     * by extractIncomingNodes to discriminate between the array carriers
     * and the bare single-node shape.
     */
    private looksLikeSingleNodeTask(obj: Record<string, unknown>): boolean {
        const nc = obj.nodeContext;
        const fc = obj.flowContext;

        return (
            typeof nc === 'object'
            && nc !== null
            && typeof (nc as Record<string, unknown>).id === 'string'
            && typeof (nc as Record<string, unknown>).kind === 'string'
            && typeof fc === 'object'
            && fc !== null
        );
    }

    /**
     * Strip server-set execution flags from an inbound NodeTask.
     *
     * `ready`, `inProgress` (and `completed` on bundles) are CLIENT-OWNED
     * state. The engine has no view into whether the client has actually
     * fired a per-node call for a given node — its `ready: true` is just
     * its own internal optimistic-preview state, often pre-set for every
     * node it returns. If we trust it, the drain loop's
     * `filter(!ready && !inProgress)` finds nothing pending and the
     * bundle "completes" without executing anything.
     *
     * Force both flags false on arrival so the local state machine
     * starts from a known clean slate.
     */
    private scrubInboundNode(node: NodeTask): NodeTask {
        return {
            ...node,
            ready: false,
            inProgress: false
        };
    }

    /**
     * Register every incoming child bundle of a parallelFlowTask,
     * replace node.parallelFlowTask with the array of their keys.
     * Marks the node as ready iff all referenced children are already
     * completed (rare — only when the children's drains finished
     * before this node was processed).
     */
    private async normaliseParallelFlowTask(node: NodeTask): Promise<void> {
        const incoming = node.parallelFlowTask as FlowTaskBundle[];
        const ids: string[] = [];

        for (const child of incoming) {
            this.registerBundle(child);
            ids.push(bundleKey(child.flowTask.flowContext));
        }

        node.parallelFlowTask = ids;

        /**
         * Drain children in parallel right now — keeps the work
         * fanning out instead of waiting for the next outer-loop pass.
         */
        await Promise.all(
            ids
                .map((id) => this.bundles.get(id))
                .filter((b): b is FlowTaskBundle => Boolean(b))
                .map((b) => this.drainBundle(b))
        );

        if (this.cancelled) {
            return;
        }

        this.maybeMarkParallelHostReady(node);
    }

    /**
     * Clone the template bundle 'total' times — each clone gets fresh
     * flowId, sessionId, requestId, flowContext.contextNumber — register
     * each, replace node.parallelContextTask with the array of keys,
     * drain the children in parallel.
     */
    private async normaliseParallelContextTask(bundle: FlowTaskBundle, node: NodeTask): Promise<void> {
        const spec = node.parallelContextTask as { flowTask: FlowTaskBundle; total: number };
        const { flowTask: template, total } = spec;
        const ids: string[] = [];

        for (let index = 0; index < total; index += 1) {
            const clone = this.cloneBundleForContext(bundle, template, index);

            this.registerBundle(clone);
            ids.push(bundleKey(clone.flowTask.flowContext));
        }

        node.parallelContextTask = ids;

        /**
         * For each clone, the server still needs an initial 'run' to
         * resolve the entry against this specific (sessionId, context)
         * key. ChatAPI.sendContextRun is the path; we fire all N in
         * parallel and let the outer drain loop pick up their
         * nodeTasks once they reply.
         *
         * Actually — the spec says the parallelContextTask CARRIES
         * the bundle (with nodeTasks already). So we don't need to
         * re-fetch anything; we just register the clones and drain
         * them. The presence of nodeTasks in the template is the
         * authoritative source.
         */
        await Promise.all(
            ids
                .map((id) => this.bundles.get(id))
                .filter((b): b is FlowTaskBundle => Boolean(b))
                .map((b) => this.drainBundle(b))
        );

        if (this.cancelled) {
            return;
        }

        this.maybeMarkParallelHostReady(node);
    }

    /**
     * If a node is a parallel host (its parallelFlowTask or
     * parallelContextTask is the normalised Array<string> form) and
     * every referenced child bundle is completed, mark the node
     * ready. Called both at the end of normalisation and whenever
     * a child completes.
     */
    private maybeMarkParallelHostReady(node: NodeTask): void {
        const ids = this.collectParallelHostIds(node);

        if (ids.length === 0) {
            return;
        }

        const allDone = ids.every((id) => this.bundles.get(id)?.flowTask.flowContext.completed === true);

        if (allDone) {
            node.inProgress = false;
            node.ready = true;
            this.emitUpdate();
        }
    }

    private collectParallelHostIds(node: NodeTask): string[] {
        const out: string[] = [];

        if (Array.isArray(node.parallelFlowTask)) {
            for (const v of node.parallelFlowTask) {
                if (typeof v === 'string') {
                    out.push(v);
                }
            }
        }

        if (Array.isArray(node.parallelContextTask)) {
            for (const v of node.parallelContextTask) {
                if (typeof v === 'string') {
                    out.push(v);
                }
            }
        }

        return out;
    }

    private isInboundParallelFlowTask(field: NodeTask['parallelFlowTask']): field is FlowTaskBundle[] {
        if (!Array.isArray(field) || field.length === 0) {
            return false;
        }

        return typeof field[0] !== 'string';
    }

    private isInboundParallelContextTask(
        field: NodeTask['parallelContextTask']
    ): field is { flowTask: FlowTaskBundle; total: number } {
        return Boolean(field) && !Array.isArray(field);
    }

    private isNormalisedParallelHost(node: NodeTask): boolean {
        return this.collectParallelHostIds(node).length > 0;
    }

    /**
     * True only if EVERY parallel-host node inside the bundle has
     * its referenced children completed. A bundle with no parallel
     * hosts trivially satisfies this. Used to decide whether to flip
     * the bundle's flowContext.completed flag.
     */
    private allParallelDependenciesReady(bundle: FlowTaskBundle): boolean {
        for (const node of bundle.nodeTasks) {
            const ids = this.collectParallelHostIds(node);

            if (ids.length === 0) {
                continue;
            }

            const allDone = ids.every((id) => this.bundles.get(id)?.flowTask.flowContext.completed === true);

            if (!allDone) {
                return false;
            }
        }

        return true;
    }

    /**
     * Mint a fresh bundle from a parallelContextTask template.
     * Server told us the entry + initial nodeTasks; we clone the
     * structure and re-mint identity (flowId, sessionId, requestId) so
     * each copy has its own dict context. flowContext.contextNumber = index.
     */
    private cloneBundleForContext(parent: FlowTaskBundle, template: FlowTaskBundle, index: number): FlowTaskBundle {
        const templateFc = template.flowTask.flowContext;
        const parentFc = parent.flowTask.flowContext;

        const fresh: FlowTaskBundle = {
            flowTask: {
                // Keep the access_token on cloned bundles so their node
                // dispatches re-stamp it on the wire (per-message verify).
                userContext: { ...parent.flowTask.userContext, accessToken: this.chat.accessToken },
                /**
                 * Inherit the parent's rootFlowContext + rootAgentContext +
                 * chatContext — clones live inside the same flow tree (and
                 * the same chat) as their spawning parent, just with their
                 * own context index. chatContext stays IDENTICAL across all
                 * clones so every history row written by a context branch
                 * still groups under the chat that originated the run.
                 */
                rootFlowContext: parent.flowTask.rootFlowContext,
                rootAgentContext: parent.flowTask.rootAgentContext,
                chatContext: parent.flowTask.chatContext,
                flowContext: {
                    flowId: generateRequestId(),
                    correlationId: parentFc.correlationId,
                    sessionId: generateRequestId(),
                    requestId: generateRequestId(),
                    parentFlowId: parentFc.flowId,
                    contextNumber: index,
                    contextPath: typeof templateFc.contextPath === 'string' ? templateFc.contextPath : '',
                    entry: templateFc.entry,
                    completed: false
                },
                options: {
                    ...template.flowTask.options
                }
            },
            nodeTasks: template.nodeTasks.map((n) => ({ ...n, inProgress: false, ready: false }))
        };

        return fresh;
    }

    private registerBundle(bundle: FlowTaskBundle): void {
        const key = bundleKey(bundle.flowTask.flowContext);

        this.bundles.set(key, bundle);
        this.emitUpdate();
    }

    /**
     * Start firing chat.sendPing() every HEARTBEAT_INTERVAL_MS so the
     * engine's dict / session TTLs stay refreshed while the flow is in
     * flight. No-op if a heartbeat is already running (run() is the
     * only caller and rejects re-entry).
     */
    private startHeartbeat(): void {
        if (this.heartbeatTimer !== null) {
            return;
        }

        this.heartbeatTimer = setInterval(() => {
            this.chat.sendPing();
        }, CHAT_SETTINGS.HEARTBEAT_INTERVAL_MS);
    }

    /**
     * Stop the heartbeat. Idempotent. Called from run()'s finally so
     * it covers the success path, every throw, and cancel.
     */
    private stopHeartbeat(): void {
        if (this.heartbeatTimer === null) {
            return;
        }

        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
    }

    private hasIncomplete(): boolean {
        for (const b of this.bundles.values()) {
            if (!b.flowTask.flowContext.completed) {
                return true;
            }
        }

        return false;
    }

    private snapshotAndClear(): ReadonlyMap<string, FlowTaskBundle> {
        const snap = new Map(this.bundles);

        this.clear();
        return snap;
    }

    private emitUpdate(): void {
        for (const handler of this.updateHandlers) {
            handler(this.bundles);
        }
    }

    /**
     * Flip the running flag and fan out to onRunning subscribers.
     * Idempotent: if the value already matches the current state, no
     * fire (no `true → true` or `false → false` duplicates).
     */
    private setRunning(value: boolean): void {
        if (this.running === value) {
            return;
        }

        this.running = value;

        for (const handler of this.runningHandlers) {
            handler(value);
        }
    }

    /**
     * Tolerant normaliser for the inbound bundle shape. Real-world
     * deviations from the canonical FlowTaskBundle we accept:
     *
     *   1. `options` arrives as a sibling of flowTask/nodeTasks
     *      instead of inside flowTask. We move it under flowTask.
     *   2. flowTask.flowContext.completed and nodeTask.ready /
     *      nodeTask.inProgress can arrive from the server as `true` —
     *      but those flags are CLIENT-OWNED execution state, not
     *      server state. Force them false on every inbound bundle so
     *      the local drain loop drives execution from a known clean
     *      slate. Completion is signalled explicitly by the EndNode's
     *      `final: true` response, NOT by the inbound bundle's
     *      completed flag.
     */
    private normaliseInboundBundle(raw: unknown): FlowTaskBundle {
        const data = raw as {
            flowTask?: Partial<App.Chat.FlowTask> & {
                options?: Record<string, unknown>;
                flowContext?: Partial<App.Chat.FlowTaskFlowContext>;
            };
            nodeTasks?: NodeTask[];
            options?: Record<string, unknown>;
        };

        const flowTaskIn = (data?.flowTask ?? {}) as Partial<App.Chat.FlowTask> & {
            options?: Record<string, unknown>;
            flowContext?: Partial<App.Chat.FlowTaskFlowContext>;
        };

        if (flowTaskIn.options === undefined && data?.options !== undefined) {
            flowTaskIn.options = data.options;
        }

        if (flowTaskIn.options === undefined) {
            flowTaskIn.options = {};
        }

        const flowContextIn = (flowTaskIn.flowContext ?? {}) as Partial<App.Chat.FlowTaskFlowContext>;

        flowContextIn.completed = false;

        flowTaskIn.flowContext = flowContextIn as App.Chat.FlowTaskFlowContext;

        const incomingNodes = (data?.nodeTasks ?? []).map((n) => this.scrubInboundNode(n));

        /**
         * virtualStartNode visual entry — client-only. When this
         * inbound bundle is a script-tool childFlow (toolFlow:true
         * with a virtualScriptNode as the first nodeTask), prepend
         * a virtualStartNode so the visualizer renders the full
         * virtualStart → virtualScript → virtualEnd chain. Never
         * travels on the wire; ready/inProgress flags keep it out
         * of the drain loop's dispatch path.
         */
        const isScriptToolBundle =
            flowTaskIn.toolFlow === true &&
            incomingNodes.length > 0 &&
            incomingNodes[0].nodeContext.kind === 'virtualScriptNode';

        if (isScriptToolBundle) {
            const firstFlowContext = incomingNodes[0].flowContext;
            const syntheticOk: App.Chat.Envelope = { success: true, code: 'E1001', message: 'OK' };
            incomingNodes.unshift({
                flowContext: { ...firstFlowContext },
                nodeContext: { id: `vStart-${generateUUID()}`, kind: 'virtualStartNode', initial: false },
                ready: true,
                inProgress: false,
                response: syntheticOk
            });
        }

        return {
            flowTask: flowTaskIn as App.Chat.FlowTask,
            nodeTasks: incomingNodes
        };
    }
}
