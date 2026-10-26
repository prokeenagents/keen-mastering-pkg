/**
 * agent-runner — a headless bridge that lets a BUILDING agent (Codex / Claude)
 * run a Keen flow and SEE it: the live onStream progress AND the returned
 * flow-tree (node-by-node request → response), all as plain text on stdout. No
 * containers, no browser. The agent shells out to this and reads the output.
 *
 * The runner subscribes to onStream on the agent's behalf and turns every frame
 * into a line of stdout — THAT is the "hook": the JS callback lives here, its
 * output is the agent's input.
 *
 *   node --import tsx run.ts \
 *     --host <keenHost> --space <spaceId> --agent <agentSlug> \
 *     --token <consumerAccessToken> --prompt "build me an offer" [--json]
 *
 * The WS endpoint derives from the bare KEEN_HOST: wss://<host>/ws-keen.
 * Auth is token-only: pass a consumer --token (KEEN_TOKEN); its `sub` is sealed,
 * so also supply --user-id (KEEN_USER_ID) and --email (KEEN_EMAIL) for identity.
 */
import 'dotenv/config';

import { format } from 'node:util';

import { WebSocket } from 'ws';

import ChatAPI from './sdk/index';

/**
 * stdout carries ONLY this runner's own lines (NDJSON with --json) — the SDK is
 * the browser Chat SDK and may console.log progress (e.g. parallelContext
 * batches), which would put a non-JSON line into the stream. Route console.log
 * to stderr before anything else runs.
 */
console.log = (...parts: unknown[]): void => {
    process.stderr.write(format(...parts) + '\n');
};

/** The last transport error the socket raised ('Unexpected server response: 502', ECONNREFUSED, a TLS error …). */
let lastSocketError = '';

/**
 * The SDK calls `new WebSocket(url)` (the browser global). Provide it in Node,
 * optionally stamping an Origin header — the Keen relay refuses the upgrade of
 * a connection whose Origin is not allow-listed (the origins of the webhook
 * records bound to api_keys; a browser sends its page origin, a Node client
 * sends none, so pass --origin <allowed>). The SDK's onerror sees
 * no detail, so the subclass also keeps the real error for the failure message.
 */
function installWebSocket(origin?: string): void {
    class Impl extends WebSocket {
        constructor(address: string, protocols?: string | string[]) {
            super(address, protocols, origin ? { origin } : {});
            this.on('error', (err: Error) => {
                lastSocketError = err.message;
            });
        }
    }

    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = Impl;
}

// ----------------------------------------------------------------- args

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): Args {
    const args: Args = {};

    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];

        if (!token.startsWith('--')) {
            continue;
        }

        const eq = token.indexOf('=');

        // --key=value (the form keen-validate / keen-deploy also accept)
        if (eq > 2) {
            args[token.slice(2, eq)] = token.slice(eq + 1);
            continue;
        }

        const key = token.slice(2);
        const next = argv[i + 1];

        if (next === undefined || next.startsWith('--')) {
            args[key] = true;
        } else {
            args[key] = next;
            i++;
        }
    }

    return args;
}

/**
 * Cookies the building agent wants the flow's script nodes to see, as an
 * explicit { name: value } map. There is NO browser here (document.cookie is
 * empty in Node), so the agent supplies the values itself — exactly the cookie
 * a real user's browser would carry (e.g. a Google-Connect token). Sources,
 * later wins:
 *   KEEN_COOKIES (.env)   — "name=value" pairs separated by ';' or newlines
 *   --cookie name=value   — repeatable on the command line
 * Returns undefined when none are given, so the SDK keeps its default.
 * The engine stores them at cookieStorage:{cid}_{sid}; scripts read a value
 * with `import Cookies from 'system/cookies'; Cookies.get('name')`.
 */
function parseCookies(argv: string[]): Record<string, string> | undefined {
    const out: Record<string, string> = {};

    const add = (pair: string): void => {
        const idx = pair.indexOf('=');
        if (idx <= 0) {
            return;
        }
        const name = pair.slice(0, idx).trim();
        if (name) {
            out[name] = pair.slice(idx + 1).trim();
        }
    };

    const fromEnv = process.env.KEEN_COOKIES;
    if (fromEnv) {
        fromEnv.split(/[;\n]/).forEach(pair => add(pair.trim()));
    }
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--cookie' && argv[i + 1] !== undefined) {
            add(argv[i + 1]);
            i++;
        } else if (argv[i].startsWith('--cookie=')) {
            add(argv[i].slice('--cookie='.length));
        }
    }

    return Object.keys(out).length > 0 ? out : undefined;
}

function fail(message: string): never {
    process.stderr.write(`agent-runner: ${message}\n`);
    process.exit(2);
}

// ---------------------------------------------------------------- token

/** Decode a JWT payload WITHOUT verifying — we only read sub/email for the SDK identity; the relay verifies the signature. */
function decodeJwt(token: string): { sub?: string; email?: string; [k: string]: unknown } {
    const bare = token.replace(/^Bearer\s+/i, '').trim();
    const parts = bare.split('.');

    if (parts.length < 2) {
        return {};
    }

    try {
        return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    } catch {
        return {};
    }
}

/**
 * Derive the WebSocket endpoint from the bare KEEN_HOST — the single source for
 * every URL. Tolerates a stray scheme / trailing slash on the host value:
 *   keen.example.com  →  wss://keen.example.com/ws-keen
 */
function wsFromHost(host: string): string {
    const bare = host
        .replace(/^[a-z]+:\/\//i, '')
        .replace(/\/+$/, '');

    return `wss://${bare}/ws-keen`;
}

// ----------------------------------------------------------------- emit

/** Credential keys never printed: the SDK re-stamps the live access_token on every bundle's userContext. */
const SECRET_KEYS = new Set(['accessToken', 'refreshToken', 'access_token', 'refresh_token']);

/** A deep copy with every credential value replaced — what reaches stdout. */
function redact(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(redact);
    }
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, inner] of Object.entries(value)) {
            out[key] = SECRET_KEYS.has(key) && inner ? '<redacted>' : redact(inner);
        }
        return out;
    }
    return value;
}

type Bundle = {
    flowTask?: { flowContext?: { flowId?: string } };
    nodeTasks?: Array<{ nodeContext?: { kind?: string; id?: string }; response?: { success?: boolean; data?: { final?: unknown } } }>;
};

/** Whether the flow reached an End node — its reply is `{ final: true }`. A flow also completes when an unwired output ends it. */
function endReached(bundle: Bundle): boolean {
    return (bundle.nodeTasks ?? []).some(n => n.response?.success === true && n.response.data?.final === true);
}

function makeEmitter(json: boolean) {
    return {
        stream(event: string, data: unknown, rid?: string): void {
            const safe = redact(data);
            if (json) {
                process.stdout.write(JSON.stringify({ t: 'stream', event, rid, data: safe }) + '\n');
            } else {
                const text = typeof safe === 'string' ? safe : JSON.stringify(safe);
                process.stdout.write(`  ┃ ${event}${rid ? ` (${rid.slice(0, 8)})` : ''}: ${text}\n`);
            }
        },
        node(key: string, bundle: Bundle): void {
            const reached = endReached(bundle);
            if (json) {
                process.stdout.write(JSON.stringify({ t: 'flow', flowId: key, endReached: reached, flowTask: redact(bundle.flowTask), nodeTasks: redact(bundle.nodeTasks) }) + '\n');
            } else {
                // The bundle key starts with the shared cid — print the flow's own id instead.
                const flowId = bundle.flowTask?.flowContext?.flowId ?? key;
                process.stdout.write(`\n▸ flow ${flowId} — ${bundle.nodeTasks?.length ?? 0} node(s)${reached ? '' : ' — no End node reached'}\n`);
                for (const n of bundle.nodeTasks ?? []) {
                    const nc = n.nodeContext ?? {};
                    const shape = n.response ? JSON.stringify(redact(n.response)) : 'no response';
                    process.stdout.write(`    • ${nc.kind ?? '?'} ${nc.id ?? ''} → ${shape.slice(0, 500)}\n`);
                }
            }
        },
        summary(ok: boolean, tree: ReadonlyMap<string, Bundle>, error?: string): void {
            const flows = tree.size;
            const reached = [...tree.values()].filter(endReached).length;
            if (json) {
                process.stdout.write(JSON.stringify({ t: 'summary', ok, flows, endReached: reached, ...(error ? { error } : {}) }) + '\n');
            } else {
                process.stderr.write(`agent-runner: ${ok ? 'OK' : 'FAILED'} — ${flows} flow bundle(s), ${reached} reached an End node${error ? ` — ${error}` : ''}\n`);
            }
        },
        meta(line: string): void {
            if (json) {
                process.stdout.write(JSON.stringify({ t: 'meta', line }) + '\n');
            } else {
                process.stderr.write(`agent-runner: ${line}\n`);
            }
        }
    };
}

// ----------------------------------------------------------------- main

const USAGE = `run.ts — run a live Keen flow and stream the trace back to a building agent.
Step 3 of the build loop:  keen-validate  →  keen-deploy  →  run.ts.

USAGE
  npx tsx run.ts --prompt "…" [--json] [flags]

CONFIG (flag first, then .env in the working dir)
  --host     / KEEN_HOST        the bare Keen host, e.g. keen.example.com (required)
                                — the WS endpoint derives: wss://<host>/ws-keen
  --space    / KEEN_SPACE_ID    the AI space id (required)
  --agent    / KEEN_AGENT       the agent SLUG (not the row id) (required)
  --token    / KEEN_TOKEN       a consumer access_token (required; token-only auth)
  --user-id  / KEEN_USER_ID     the consumer id — relay enforces userId === the token's sealed sub
  --email    / KEEN_EMAIL       identity email (presence-checked; defaults to the token's email claim)
  --origin   / KEEN_ORIGIN      Origin header — must equal the origin on the webhook record bound to the
                                api_key (the relay's allow-list), else the upgrade is refused
  --prompt   / KEEN_PROMPT      the user turn (required, per-run; the env var is only a fallback)
  --chat-id  / KEEN_CHAT_ID     reuse a chat id to continue a conversation (default: a fresh one)
  --cookie name=value           a cookie the flow's script nodes should see, read via
                                system/cookies (repeatable). Also KEEN_COOKIES="a=1;b=2"
                                in .env. Node has no browser, so you pass the value here —
                                e.g. --cookie gconnect=<token> — as a real user's browser would.
  --json                        NDJSON output (one object per frame) for the agent
  -h --help                     this help

Flags take --key value or --key=value. projectID defaults to KEEN_SPACE_ID (space id === project id).

OUTPUT
  stdout carries only the runner's lines (NDJSON with --json); credentials in the
  tree are printed as <redacted>. The last line is the summary:
    {"t":"summary","ok":true,"flows":2,"endReached":2}
  A flow can also complete WITHOUT an End node (an unwired output ends it) — each
  "flow" line says endReached true/false. On a failure the partial tree is printed
  before the summary.

EXIT CODES
  0  the run settled (check the summary's endReached)
  1  the run failed (socket closed, auth / input error, retries exhausted, cancel)
  2  bad arguments / configuration

For a self-signed dev cert, prefix the command with NODE_TLS_REJECT_UNAUTHORIZED=0.
Full docs: agent-runner/README.md · agent-runner/docs/USAGE.md
`;

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args.help === true || process.argv.includes('-h') || process.argv.includes('--help')) {
        process.stdout.write(USAGE);
        process.exit(0);
    }
    const json = args.json === true;
    const emit = makeEmitter(json);

    // Every value: --flag first, then the .env var, then a default. So the agent
    // fills .env once and just runs `run.ts --prompt "…"`; a flag overrides .env.
    const pick = (argKey: string, envKey: string): string => {
        const fromArg = args[argKey];
        if (typeof fromArg === 'string' && fromArg.length > 0) {
            return fromArg;
        }
        return process.env[envKey] ?? '';
    };
    const requirePick = (argKey: string, envKey: string, label: string): string => {
        const value = pick(argKey, envKey);
        if (!value) {
            fail(`missing --${argKey} (or ${envKey} in .env) — ${label}`);
        }
        return value;
    };

    const origin = pick('origin', 'KEEN_ORIGIN');
    installWebSocket(origin || undefined);

    // Every URL derives from the single bare host — WS = wss://<host>/ws-keen.
    const host = requirePick('host', 'KEEN_HOST', 'the Keen host, e.g. keen.example.com (no scheme, no path)');
    const url = wsFromHost(host);
    const spaceID = requirePick('space', 'KEEN_SPACE_ID', 'the space id');
    const agentID = requirePick('agent', 'KEEN_AGENT', 'the agent slug');
    const prompt = requirePick('prompt', 'KEEN_PROMPT', 'the user turn');
    // Prefer ONE stable chat id (KEEN_CHAT_ID / --chat-id) reused across runs, so
    // repeated runs CONTINUE one conversation instead of spawning a new chat thread
    // every run (a fresh thread each time spams the user's chat list). Switch to a
    // NEW id only when the agent goes erratic/incoherent — a fresh session resets
    // the conversation context. When none is given we mint one and warn below.
    const chatIdGiven = pick('chat-id', 'KEEN_CHAT_ID');
    const chatId = chatIdGiven || `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    // Auth is token-only — the access_token comes from a browser session where the
    // consumer is already logged in; there is no login step here.
    const accessToken = pick('token', 'KEEN_TOKEN').replace(/^Bearer\s+/i, '').trim();
    if (!accessToken) {
        fail(
            [
                'no consumer access_token — this is how you get one:',
                '',
                '  Headless (preferred for an agent) — the Keen MCP server:',
                '    1. As an MCP account, create an MCP consumer (create_mcp_consumer → its id + secret).',
                '    2. Call get_mcp_consumer_token with that id + secret → the access_token.',
                '    3. Put it in .env as  KEEN_TOKEN=<token>  and the consumer id as  KEEN_USER_ID=<id>.',
                '    (../keen-mcp-guide/README.md walks through it.)',
                '',
                '  A human consumer instead:',
                "    1. Open the CONSUMER app/site in your browser, logged in as that consumer, and copy the",
                "       access_token from its cookies (DevTools → Application → Cookies).",
                '    2. Set  KEEN_TOKEN=<token>  and  KEEN_USER_ID=<consumer id>.',
                '',
                'The token seals its `sub`, so KEEN_USER_ID cannot be derived. Then re-run.'
            ].join('\n')
        );
    }

    const claims = decodeJwt(accessToken);
    const userId = pick('user-id', 'KEEN_USER_ID') || claims.sub || '';
    const email = pick('email', 'KEEN_EMAIL') || claims.email || '';

    if (!userId) {
        emit.meta('warning: no userId (token seals its `sub`, no --user-id / KEEN_USER_ID) — the run may be rejected');
    }

    emit.meta(`connect ${url} · space=${spaceID} · agent=${agentID} · chat=${chatId}`);
    if (!chatIdGiven) {
        emit.meta(`fresh chat id minted — set KEEN_CHAT_ID=${chatId} (or --chat-id ${chatId}) to keep continuing THIS thread on the next run instead of spawning a new chat each time`);
    }

    // projectID defaults to the space id (space id === project id).
    const chat = new ChatAPI({ url, spaceID, agentID, userId, email, projectID: spaceID, accessToken, cookies: parseCookies(process.argv.slice(2)) });

    chat.onStream((event, data, requestId) => emit.stream(event, data, requestId));
    chat.connect();

    // Ctrl+C = STOP THE FLOW, not just kill the client: sendCancel tells the relay
    // to wipe this cid's dict/session/agentState/queue on the engines, so a
    // half-run leaves nothing behind. Second Ctrl+C hard-exits.
    let cancelling = false;
    process.on('SIGINT', () => {
        if (cancelling) {
            process.exit(130);
        }
        cancelling = true;
        emit.meta('SIGINT — cancelling flow on the engine');
        try {
            chat.sendCancel();
        } catch {
            // best-effort — we exit regardless
        }
        chat.disconnect();
        setTimeout(() => process.exit(130), 300);
    });

    // The TaskQueue clears its map before a failed run throws — keep the last
    // non-empty view so the failure still shows how far the flow got.
    let partial: ReadonlyMap<string, Bundle> = new Map();
    chat.taskQueue.onUpdate(bundles => {
        if (bundles.size > 0) {
            partial = new Map(bundles);
        }
    });

    let code = 0;

    try {
        // Gate the run on the relay's welcome (it assigns the connection cid the
        // run must carry). Without this, TaskQueue mints a fallback cid the relay
        // rejects as a mismatch. whenReady itself never settles when the socket
        // closes first, so a close before the welcome fails here with its cause.
        let stopWatching = (): void => undefined;
        const closedFirst = new Promise<never>((_, reject) => {
            stopWatching = chat.onStatus(status => {
                if (status === 'disconnected') {
                    let cause = lastSocketError || 'closed by the server — is the origin allow-listed?';
                    if (/Unexpected server response: (403|502)/.test(cause)) {
                        cause += ' — the relay refuses an Origin that is not allow-listed (or the relay is down)';
                    }
                    reject(new Error(`socket closed before the relay's welcome: ${cause}`));
                }
            });
        });
        let timer: NodeJS.Timeout | undefined;
        const cid = await Promise.race([
            chat.whenReady(),
            closedFirst,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('no welcome from the relay within 15s (relay up? origin allow-listed?)')), 15_000);
            })
        ]).finally(() => {
            stopWatching();
            clearTimeout(timer);
        });
        emit.meta(`ready — cid ${cid}`);

        const tree = await chat.runFlow({ chatId, prompt });
        emit.meta(`run complete — ${tree.size} flow bundle(s)`);
        for (const [key, bundle] of tree) {
            emit.node(key, bundle);
        }
        emit.summary(true, tree);
    } catch (err) {
        code = 1;
        const message = err instanceof Error ? err.message : String(err);
        emit.meta(`run FAILED: ${message}`);
        if (partial.size > 0) {
            emit.meta(`partial tree — ${partial.size} flow bundle(s) at the failure`);
            for (const [key, bundle] of partial) {
                emit.node(key, bundle);
            }
        }
        emit.summary(false, partial, message);
    } finally {
        chat.disconnect();
    }

    // Give the socket a beat to close, then exit deterministically.
    setTimeout(() => process.exit(code), 200);
}

main().catch(err => fail(err instanceof Error ? err.message : String(err)));
