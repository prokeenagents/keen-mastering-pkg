/**
 * agent-runner deploy — the UPLOADER half. A building agent changes flow/script
 * code, then runs this to push it live (so it can then run it via run.ts). It
 * speaks the Keen deploy protocol directly: connect (deploy token → session) → zip
 * the project → upload (synchronous: the platform scans + promotes and answers
 * deployed / rejected right away) → disconnect.
 *
 *   node --import tsx deploy.ts            # all config from .env
 *   node --import tsx deploy.ts --project ./my-flow-project --json
 *
 * Config (flag first, then .env):
 *   --host        / KEEN_HOST          bare Keen host, e.g. keen.example.com
 *                                      (deploy base derives: https://<host>/ms/deploy)
 *   --space       / KEEN_SPACE_ID      the AI space id
 *   --deploy-token/ KEEN_DEPLOY_TOKEN  the space's deployment token
 *   --project     / KEEN_PROJECT_DIR   the flow project ROOT (the folder with src/)
 *   --json                             NDJSON output for the agent
 *
 * Only what ms-deploy builds is uploaded — flows/, scripts/ and keen-tools.json —
 * and never a dot-entry (.env, .vscode/keen.json, .git …), so a mis-pointed
 * project dir can't ship secrets.
 */
import 'dotenv/config';

import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

import { zipSync } from 'fflate';

/** dotenv does NOT expand ~ — a value like `~/Desktop/BuildTest` arrives literal, so do it here. */
function expandTilde(p: string): string {
    if (p === '~') {
        return homedir();
    }
    if (p.startsWith('~/') || p.startsWith('~\\')) {
        return join(homedir(), p.slice(2));
    }
    return p;
}

// ------------------------------------------------------------------ args

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): Args {
    const args: Args = {};
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith('--')) {
            continue;
        }
        const eq = token.indexOf('=');
        if (eq > 2) {
            args[token.slice(2, eq)] = token.slice(eq + 1); // --key=value
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

/** Bad arguments / configuration — exit 2, nothing was sent. */
function fail(message: string): never {
    process.stderr.write(`agent-runner deploy: ${message}\n`);
    process.exit(2);
}

const USAGE = `deploy.ts — push a flow project live (step 2 of the build loop:  keen-validate  →  keen-deploy / deploy.ts  →  run.ts).

USAGE
  npx tsx deploy.ts [--json] [flags]          # everything else from .env in the working dir

CONFIG (flag first, then .env; --key value or --key=value)
  --host         / KEEN_HOST          the bare Keen host, e.g. keen.example.com (deploy base: https://<host>/ms/deploy)
  --space        / KEEN_SPACE_ID      the AI space id
  --deploy-token / KEEN_DEPLOY_TOKEN  the space's deployment token
  --project      / KEEN_PROJECT_DIR   the flow project ROOT — the folder that holds src/ (default: .)
  --json                              NDJSON output for the agent
  -h --help                           this help

WHAT IS UPLOADED
  <root>/src (or <root> itself when it has no src/) must hold flows/. Only flows/, scripts/
  and keen-tools.json are zipped; dot-entries (.env, .vscode, .git …), node_modules and
  .zip files never are.

EXIT CODES
  0  deployed
  1  rejected by the platform, or the connect / upload failed (network, TLS, HTTP status)
  2  bad arguments / configuration (nothing was sent)

For a self-signed dev cert, prefix the command with NODE_TLS_REJECT_UNAUTHORIZED=0.
Full docs: agent-runner/docs/DEPLOY.md
`;

// ------------------------------------------------------------------ emit

function makeEmitter(json: boolean) {
    return (t: string, payload: Record<string, unknown>): void => {
        if (json) {
            process.stdout.write(JSON.stringify({ t, ...payload }) + '\n');
        } else {
            const detail = Object.entries(payload)
                .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
                .join('  ');
            process.stdout.write(`[${t}] ${detail}\n`);
        }
    };
}

// ------------------------------------------------------------------ zip

/** The root entries ms-deploy builds (builder/build-project.ts) — nothing else is uploaded. */
const UPLOAD_ROOT = new Set(['flows', 'scripts', 'keen-tools.json']);

/**
 * Zip the given directory's CONTENTS (so flows/ + scripts/ land at the zip
 * root) with fflate — pure JS, in-memory, so it works identically on Windows /
 * macOS / Linux with no external `zip`. Takes only UPLOAD_ROOT at the top level
 * and skips every dot-entry (.env, .vscode, .git …), node_modules and stray .zip
 * files at any depth. Returns the skipped root entries so the caller can say so.
 */
async function zipDir(dir: string): Promise<{ zip: Buffer; skipped: string[] }> {
    const files: Record<string, Uint8Array> = {};
    const skipped: string[] = [];

    async function walk(current: string): Promise<void> {
        for (const entry of await readdir(current, { withFileTypes: true })) {
            const full = join(current, entry.name);
            const rel = relative(dir, full).split(sep).join('/'); // posix paths inside the zip

            if (current === dir && !UPLOAD_ROOT.has(entry.name)) {
                skipped.push(entry.name);
                continue;
            }
            if (entry.name.startsWith('.') || entry.name === 'node_modules') {
                continue;
            }
            if (entry.isDirectory()) {
                await walk(full);
            } else if (entry.isFile() && !entry.name.endsWith('.zip')) {
                files[rel] = new Uint8Array(await readFile(full));
            }
        }
    }

    await walk(dir);
    return { zip: Buffer.from(zipSync(files, { level: 9 })), skipped: skipped.sort() };
}

// ------------------------------------------------------------------ http

async function post(url: string, headers: Record<string, string>, body?: BodyInit): Promise<{ status: number; json: unknown; text: string }> {
    const res = await fetch(url, { method: 'POST', headers, body });
    const text = await res.text();
    let parsed: unknown = null;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch {
        parsed = null;
    }
    return { status: res.status, json: parsed, text };
}

// ------------------------------------------------------------------ main

const jsonOut = process.argv.includes('--json');

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args.help === true || process.argv.includes('-h')) {
        process.stdout.write(USAGE);
        process.exit(0);
    }
    const json = args.json === true;
    const emit = makeEmitter(json);

    const pick = (argKey: string, envKey: string): string => {
        const fromArg = args[argKey];
        if (typeof fromArg === 'string' && fromArg.length > 0) {
            return fromArg;
        }
        return process.env[envKey] ?? '';
    };
    const require = (argKey: string, envKey: string, label: string): string => {
        const value = pick(argKey, envKey);
        if (!value) {
            fail(`missing --${argKey} (or ${envKey} in .env) — ${label}`);
        }
        return value;
    };

    // Every URL derives from the single bare host: deploy base = https://<host>/ms/deploy.
    const host = require('host', 'KEEN_HOST', 'the Keen host, e.g. keen.example.com (no scheme, no path)');
    const base = 'https://' + host.replace(/^https?:\/\//, '').replace(/\/+$/, '') + '/ms/deploy';
    const spaceId = require('space', 'KEEN_SPACE_ID', 'the AI space id');
    const deployToken = require('deploy-token', 'KEEN_DEPLOY_TOKEN', "the space's deployment token");
    const projectDir = resolve(expandTilde(pick('project', 'KEEN_PROJECT_DIR') || '.'));

    const dirStat = await stat(projectDir).catch(() => null);
    if (!dirStat?.isDirectory()) {
        fail(`--project is not a directory: ${projectDir}`);
    }

    // B1: KEEN_PROJECT_DIR is the project ROOT. If it has a src/ subdir, zip its
    // CONTENTS (so flows/ + scripts/ land at the zip root); otherwise zip the root
    // directly (back-compat). One value serves both keen-validate (wants the root)
    // and deploy. Either way it must hold flows/ — refused here, before anything
    // is sent, so a wrong dir (e.g. the runner's own, with its .env) never uploads.
    const srcDir = join(projectDir, 'src');
    const srcStat = await stat(srcDir).catch(() => null);
    const zipRoot = srcStat?.isDirectory() ? srcDir : projectDir;
    const flowsStat = await stat(join(zipRoot, 'flows')).catch(() => null);
    if (!flowsStat?.isDirectory()) {
        fail(`no flows/ in ${zipRoot} — --project / KEEN_PROJECT_DIR must be the flow project ROOT (the folder that holds src/flows)`);
    }

    // 1) connect — the deploy token + space authenticate; we get a short-lived session token.
    emit('meta', { step: 'connect', base, space: spaceId });
    const connectRes = await post(`${base}/v1/project/connect`, {
        'X-Deployment-Token': deployToken,
        'X-AI-Space-Id': spaceId
    });
    if (connectRes.status !== 200) {
        emit('fail', { step: 'connect', status: connectRes.status, body: connectRes.text.slice(0, 400) });
        process.exit(1);
    }
    const sessionToken = (connectRes.json as { token?: string })?.token;
    if (!sessionToken) {
        emit('fail', { step: 'connect', reason: 'no session token in reply', body: connectRes.text.slice(0, 400) });
        process.exit(1);
    }
    emit('meta', { step: 'connected', session: `${sessionToken.slice(0, 8)}…` });

    let code = 0;
    try {
        // 2) zip + 3) upload — synchronous: the reply is the deploy outcome.
        const { zip, skipped } = await zipDir(zipRoot);
        emit('meta', { step: 'zip', root: projectDir, zipping: zipRoot, ...(skipped.length > 0 ? { skipped } : {}) });
        emit('meta', { step: 'upload', bytes: zip.length });

        const form = new FormData();
        form.append('bundle', new Blob([new Uint8Array(zip)], { type: 'application/zip' }), 'bundle.zip');

        const uploadRes = await post(`${base}/v1/project/upload`, { 'X-Deployment-Token': sessionToken, 'X-AI-Space-Id': spaceId }, form);
        const reply = uploadRes.json as Record<string, unknown> | null;

        if (uploadRes.status === 200 && reply?.status === 'deployed') {
            emit('deployed', { project: reply.project, generation: reply.generation });
        } else if (uploadRes.status === 422) {
            // Well-formed bundle that failed the security scan or the structure check.
            code = 1;
            emit('rejected', {
                error: reply?.error ?? 'rejected',
                message: reply?.message ?? '',
                issues: reply?.issues ?? undefined,
                reasons: reply?.reasons ?? undefined
            });
        } else {
            code = 1;
            emit('fail', { step: 'upload', status: uploadRes.status, body: uploadRes.text.slice(0, 600) });
        }
    } finally {
        // 4) disconnect — best-effort; the session TTLs out anyway.
        await post(`${base}/v1/project/disconnect`, { 'X-Deployment-Token': sessionToken, 'X-AI-Space-Id': spaceId }).catch(() => undefined);
    }

    setTimeout(() => process.exit(code), 50);
}

// A thrown error here is the network / TLS / runtime failing mid-deploy (fetch
// rejects) — exit 1 like any other failed deploy; 2 stays for bad arguments.
main().catch(err => {
    const message = err instanceof Error ? (err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message) : String(err);
    if (jsonOut) {
        process.stdout.write(JSON.stringify({ t: 'fail', step: 'request', error: message }) + '\n');
    } else {
        process.stderr.write(`agent-runner deploy: ${message}\n`);
    }
    process.exit(1);
});
