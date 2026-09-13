'use strict';

/**
 * script-lint.js — a light, dependency-free lint of a Keen `scripts/*.js` file for the
 * runtime CONTRACTS that don't show up in the flow graph: the exec export, the import
 * allow-list (+ relative-target existence), the deploy scanner's sandbox rules, and the
 * agent-reply trigger contract (the "No tool response" class of bug).
 *
 * It is lexical (regex + balanced-bracket extraction), not a full AST — precise enough for
 * these specific patterns with a low false-positive rate, and needs no parser dependency.
 * Every regex here is written WITHOUT lookbehind/lookahead so the Go port (RE2) is the
 * same rule, byte for byte.
 */

const path = require('path');

/** The nine importable system resources (ms-script-engine system-modules.ts SUPPORTED). */
const SYSTEM_MODULES = ['chat', 'log', 'session', 'tools', 'agent', 'cookies', 'http', 'settings', 'dictionary'];

/**
 * Sandbox globals the deploy scanner refuses (ms-deploy scanner.ts:44 FORBIDDEN_GLOBALS —
 * any bare reference is a critical issue, scanner.ts:272-299).
 */
const FORBIDDEN_GLOBALS = ['eval', 'Function', 'require', 'process', 'global', 'globalThis', 'module', 'exports', '__dirname', '__filename'];

/** Prototype-pollution property names the deploy scanner refuses (scanner.ts:39, 194-267). */
const FORBIDDEN_PROPERTIES = ['__proto__', 'constructor', 'prototype', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__', 'getPrototypeOf', 'setPrototypeOf'];

/** Keywords after which a `/` starts a regex literal (not a division). */
const REGEX_KEYWORDS = ['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await'];

/** Method names of the three system modules whose READS share the one SAB (E_SAB_BUSY). */
const HTTP_READS = ['get', 'getJson', 'post', 'postJson', 'request'];
const DICT_READS = ['get'];
function isAgentRead(name) { return /^(get|consume)/.test(name); }

/** Escape a string for use inside a RegExp source. */
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** 1-based line of a character index. */
function lineOf(s, idx) {
    let line = 1;
    for (let i = 0; i < idx && i < s.length; i++) if (s[i] === '\n') line++;
    return line;
}

/**
 * Blank `//` and `/* *\/` comments with spaces (keeping newlines and offsets), skipping
 * over string/template literals so a `//` inside a string is not mistaken for a comment.
 * (Port of the Go stripper — the two must agree or Node and Go diverge.)
 */
function stripComments(source) {
    const out = source.split('');
    const n = source.length;
    let i = 0;
    while (i < n) {
        const c = source[i];
        if (c === "'" || c === '"' || c === '`') {
            const q = c;
            i++;
            while (i < n) {
                if (source[i] === '\\') { i += 2; continue; }
                if (source[i] === q) { i++; break; }
                i++;
            }
            continue;
        }
        if (c === '/' && i + 1 < n && source[i + 1] === '/') {
            while (i < n && source[i] !== '\n') { out[i] = ' '; i++; }
            continue;
        }
        if (c === '/' && i + 1 < n && source[i + 1] === '*') {
            out[i] = ' '; out[i + 1] = ' ';
            i += 2;
            while (i < n) {
                if (source[i] === '*' && i + 1 < n && source[i + 1] === '/') { out[i] = ' '; out[i + 1] = ' '; i += 2; break; }
                if (source[i] !== '\n') out[i] = ' ';
                i++;
            }
            continue;
        }
        i++;
    }
    return out.join('');
}

function isWordChar(c) { return /[A-Za-z0-9_$]/.test(c); }

/**
 * Blank the CONTENTS of string / template / regex literals (quotes and slashes stay, so
 * bracket balance and identifier rules see only code). Returns `{ code, error }` where
 * `error` names an unterminated literal. Input must already be comment-stripped.
 */
function blankLiterals(src) {
    const out = src.split('');
    const n = src.length;
    const regexAllowedBefore = pos => {
        let j = pos - 1;
        while (j >= 0 && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r')) j--;
        if (j < 0) return true;
        const c = src[j];
        if ('(,=:[!&|?{};+-*%<>~^'.includes(c)) return true;
        if (isWordChar(c)) {
            let k = j;
            while (k >= 0 && isWordChar(src[k])) k--;
            return REGEX_KEYWORDS.includes(src.slice(k + 1, j + 1));
        }
        return false;
    };
    let i = 0;
    while (i < n) {
        const c = src[i];
        if (c === "'" || c === '"' || c === '`') {
            let j = i + 1;
            let closed = false;
            while (j < n) {
                if (src[j] === '\\') { out[j] = ' '; if (j + 1 < n && src[j + 1] !== '\n') out[j + 1] = ' '; j += 2; continue; }
                if (src[j] === c) { closed = true; break; }
                if (src[j] !== '\n') out[j] = ' ';
                j++;
            }
            if (!closed) return { code: out.join(''), error: `unterminated string literal opened at line ${lineOf(src, i)}` };
            i = j + 1;
            continue;
        }
        if (c === '/' && regexAllowedBefore(i)) {
            let j = i + 1;
            let inClass = false;
            let closed = false;
            while (j < n) {
                const ch = src[j];
                if (ch === '\\') { out[j] = ' '; if (j + 1 < n && src[j + 1] !== '\n') out[j + 1] = ' '; j += 2; continue; }
                if (ch === '\n') break;
                if (inClass) { if (ch === ']') inClass = false; }
                else if (ch === '[') inClass = true;
                else if (ch === '/') { closed = true; break; }
                out[j] = ' ';
                j++;
            }
            if (!closed) return { code: out.join(''), error: `unterminated regex literal opened at line ${lineOf(src, i)}` };
            i = j + 1;
            continue;
        }
        i++;
    }
    return { code: out.join(''), error: null };
}

/** Bracket balance over literal-blanked code. Returns an error string or null. */
function checkBalance(code) {
    const open = { ')': '(', ']': '[', '}': '{' };
    const stack = [];
    for (let i = 0; i < code.length; i++) {
        const c = code[i];
        if (c === '(' || c === '[' || c === '{') { stack.push({ ch: c, idx: i }); continue; }
        if (c === ')' || c === ']' || c === '}') {
            if (stack.length === 0 || stack[stack.length - 1].ch !== open[c]) return `unexpected "${c}" at line ${lineOf(code, i)}`;
            stack.pop();
        }
    }
    if (stack.length > 0) { const top = stack[stack.length - 1]; return `unclosed "${top.ch}" opened at line ${lineOf(code, top.idx)}`; }
    return null;
}

/** From `open` index of an opening bracket, return the index just after its balanced close (or -1). */
function matchBracket(src, open, openCh, closeCh) {
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (c === openCh) depth++;
        else if (c === closeCh) { depth--; if (depth === 0) return i + 1; }
        // skip strings/templates
        else if (c === "'" || c === '"' || c === '`') { i = skipString(src, i, c); }
    }
    return -1;
}
function skipString(src, i, quote) {
    for (let j = i + 1; j < src.length; j++) {
        if (src[j] === '\\') { j++; continue; }
        if (src[j] === quote) return j;
    }
    return src.length - 1;
}

/**
 * Parse an import clause (`X`, `* as X`, `{ a, b as c }`, `X, { a }`) into the local
 * bindings: `defaults` (default + namespace locals) and `named` ({ local, imported }).
 */
function parseImportClause(clause) {
    const out = { defaults: [], named: [] };
    if (!clause) return out;
    let rest = clause;
    const bs = clause.indexOf('{');
    if (bs >= 0) {
        const be = clause.indexOf('}', bs);
        const inner = be > bs ? clause.slice(bs + 1, be) : clause.slice(bs + 1);
        for (const part of inner.split(',')) {
            const p = part.trim();
            if (!p) continue;
            const as = p.split(/\s+as\s+/);
            if (as.length === 2) out.named.push({ local: as[1].trim(), imported: as[0].trim() });
            else out.named.push({ local: p, imported: p });
        }
        rest = clause.slice(0, bs) + (be > bs ? clause.slice(be + 1) : '');
    }
    for (const part of rest.split(',')) {
        const p = part.trim();
        if (!p) continue;
        if (p.startsWith('*')) { const m = p.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/); if (m) out.defaults.push(m[1]); }
        else if (/^[A-Za-z_$][\w$]*$/.test(p)) out.defaults.push(p);
    }
    return out;
}

/** An object KEY named `key` — preceded (after whitespace) by `{` or `,`, followed by `:`, `,` or `}` (shorthand). Never a VALUE identifier. */
function keyRe(key) { return new RegExp(`(^|[{,])\\s*${key}\\s*[:,}]`); }

/**
 * Lint one script.
 *   emit(level, msg) — level ∈ 'error' | 'warn' | 'info'
 *   opts.isTool  — true if this file is registered as a script tool (under tools/)
 *   opts.isEntry — true if a Script node or a tool runs it (needs `exec`); false = helper module
 *   opts.rel     — the file's path relative to src/scripts (posix), for relative-import resolution
 *   opts.exists  — (relPath) => boolean, whether a file exists under src/scripts
 */
function lintScript(source, emit, opts = {}) {
    const src = stripComments(source);
    const lit = blankLiterals(src);
    const code = lit.code;

    // ── 0. syntax pre-check ───────────────────────────────────────────────────
    const syn = lit.error || checkBalance(code);
    if (syn) emit('error', `syntax pre-check: ${syn} — the deploy scanner rejects any script that fails to parse (ms-deploy scanner.ts:60-76); this is a bracket/quote balance check, not a full parser`);

    // ── 1. exec export ────────────────────────────────────────────────────────
    const hasExecDecl = /export\s+(async\s+)?(const|let|var|function)\s+exec\b/.test(src)
        || /export\s*\{[^}]*\bexec\b[^}]*\}/.test(src);
    // Only an ENTRY script (a Script node's file, or a registered script tool) needs `exec`;
    // a helper module imported relatively is a normal module and exports whatever it likes.
    const isEntry = opts.isEntry !== false;
    if (isEntry && !hasExecDecl) emit('error', 'no exported `exec` — a script must `export const exec = (props) => {…}` (named, not default)');
    if (isEntry && /export\s+default\b/.test(src) && !hasExecDecl)
        emit('error', 'uses `export default` — the runner reads a NAMED `exec` export, not default');

    // ── 2. imports allow-list + relative targets + bindings ──────────────────
    const bindings = {}; // spec → { defaults: [], named: [] }
    const importRe = /import\s+(?:([\w*{}\s,]+?)\s+from\s+)?['"]([^'"]+)['"]/g;
    let im;
    while ((im = importRe.exec(src))) {
        const clause = im[1] || '';
        const spec = im[2];
        if (spec === 'system/logs') { emit('error', `import '${spec}' — it is 'system/log' (singular)`); continue; }
        if (spec.startsWith('system/')) {
            const name = spec.slice('system/'.length);
            if (!SYSTEM_MODULES.includes(name))
                emit('error', `import '${spec}' — unknown system module (allowed: ${SYSTEM_MODULES.map(m => 'system/' + m).join(', ')})`);
            else bindings[spec] = parseImportClause(clause);
            continue;
        }
        if (spec.startsWith('./') || spec.startsWith('../')) {
            // own relative file — the runner resolves it inside src/scripts by EXACT path
            if (opts.rel && typeof opts.exists === 'function') {
                const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(opts.rel), spec));
                if (resolved === '..' || resolved.startsWith('../'))
                    emit('error', `import '${spec}' escapes src/scripts (resolves to "${resolved}") — the runner resolves relative imports inside the project's scripts/ only`);
                else if (!opts.exists(resolved))
                    emit('error', `import '${spec}' → scripts/${resolved} does not exist — the runner reads the exact path (no extension inference, no index.js); the deploy scan does not catch this, the run fails`);
            }
            continue;
        }
        emit('error', `import '${spec}' — only 'system/*' and relative './' '../' files are allowed (no npm packages, no absolute paths)`);
    }

    // ── 3. sandbox rules (mirror of the deploy scanner, on literal-blanked code) ──
    if (/\bfetch\s*\(/.test(code)) emit('error', 'uses fetch() — the sandbox has no network; use `import Http from \'system/http\'`');
    {
        const globalRe = new RegExp(`(^|[^\\w$.])(${FORBIDDEN_GLOBALS.join('|')})\\b(\\s*:)?`, 'g');
        const seen = new Set();
        let g;
        while ((g = globalRe.exec(code))) { if (!g[3]) seen.add(g[2]); }
        for (const name of [...seen].sort()) {
            if (name === 'require') emit('error', 'uses require() — scripts are ES modules; the deploy scanner rejects it as critical (ms-deploy scanner.ts:109-111); use `import`');
            else emit('error', `references \`${name}\` — forbidden in the sandbox; the deploy scanner rejects it as critical ("Reference to ${name} is forbidden", ms-deploy scanner.ts:44/272-299)`);
        }
    }
    if (/(^|[^\w$.])import\s*\(/.test(code)) emit('error', 'uses dynamic import() — forbidden; the deploy scanner rejects it as critical (ms-deploy scanner.ts:185-188); use a static import');
    if (/(^|[^\w$.])with\s*\(/.test(code)) emit('error', 'uses a `with` statement — forbidden; the deploy scanner rejects it as critical (ms-deploy scanner.ts:304-306)');
    {
        const props = FORBIDDEN_PROPERTIES.join('|');
        const seen = new Set();
        let m;
        const bareRe = new RegExp(`(^|[^\\w$.\\])])\\s*[A-Za-z_$][\\w$]*\\s*\\.\\s*(${props})\\b`, 'g');
        while ((m = bareRe.exec(code))) seen.add(m[2]);
        const computedRe = new RegExp(`[A-Za-z_$][\\w$]*\\s*\\[\\s*['"](${props})['"]\\s*\\]`, 'g');
        while ((m = computedRe.exec(src))) seen.add(m[1]);
        if (/\.\s*__proto__\b/.test(code) || /\[\s*['"]__proto__['"]\s*\]/.test(src)) seen.add('__proto__');
        const assignRe = new RegExp(`\\.\\s*(${props})\\s*=[^=]`, 'g');
        while ((m = assignRe.exec(code))) seen.add(m[1]);
        for (const name of [...seen].sort())
            emit('error', `accesses \`.${name}\` — prototype-pollution vector; the deploy scanner rejects it as critical (ms-deploy scanner.ts:39/194-267)`);
    }
    if (/\bcrypto\s*\./.test(code)) emit('warn', 'uses crypto — the sandbox has no crypto; use `Tools.generateUUID()` from system/tools');

    // ── 4. concurrent SAB reads (E_SAB_BUSY) — bound to the LOCAL import bindings ──
    {
        const alts = [];
        const add = (spec, methodRe, isRead) => {
            const b = bindings[spec];
            if (!b) return;
            for (const local of b.defaults) alts.push(`${esc(local)}\\s*\\.\\s*${methodRe}\\s*\\(`);
            for (const nm of b.named) if (isRead(nm.imported)) alts.push(`${esc(nm.local)}\\s*\\(`);
        };
        add('system/agent', '(get|consume)\\w*', isAgentRead);
        add('system/http', `(${HTTP_READS.join('|')})`, n => HTTP_READS.includes(n));
        add('system/dictionary', `(${DICT_READS.join('|')})`, n => DICT_READS.includes(n));
        if (alts.length > 0) {
            const readRe = new RegExp(`(^|[^\\w$.])(?:${alts.join('|')})`);
            const paRe = /Promise\.all\s*\(/g;
            let pa;
            while ((pa = paRe.exec(code))) {
                const open = code.indexOf('(', pa.index);
                const end = open >= 0 ? matchBracket(code, open, '(', ')') : -1;
                if (end > open && readRe.test(code.slice(open, end)))
                    emit('warn', 'Promise.all over system/http, system/agent or system/dictionary reads — they share one buffer (E_SAB_BUSY). await each read sequentially');
            }
        }
    }

    // ── 5. agent-reply trigger contract ──────────────────────────────────────
    // The llms-engine resolves an agent's trigger as the newest prompt with
    // role:'user' + agentChat:true + sessionID === the agent's session, and detects a
    // tool reply by the newest prompt's requestID differing from the caller's request id.
    const aliasRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*toolOptions\s*\.\s*agentNode\s*\.\s*flowContext\s*\.\s*requestId\b/g;
    const aliases = [];
    let al;
    while ((al = aliasRe.exec(src))) aliases.push(al[1]);
    const callerReqAlts = ['toolOptions\\s*\\.\\s*agentNode\\s*\\.\\s*flowContext\\s*\\.\\s*requestId'].concat(aliases.map(esc));
    const callerReqRe = new RegExp(`(^|[{,])\\s*requestID\\s*:\\s*(?:${callerReqAlts.join('|')})\\b`);
    const callRe = /\b(setRootAgentPrompt|setAgentPrompt)\s*\(/g;
    let call;
    let sawReply = false;
    while ((call = callRe.exec(src))) {
        sawReply = true;
        const open = src.indexOf('(', call.index);
        const end = open >= 0 ? matchBracket(src, open, '(', ')') : -1;
        if (end <= open) continue;
        const args = src.slice(open, end);

        // find the payload object literal (the first {...} inside the arg list)
        const objOpen = args.indexOf('{');
        if (objOpen < 0) continue; // payload is an identifier (a helper var) — can't inspect
        const objEnd = matchBracket(args, objOpen, '{', '}');
        const payload = objEnd > objOpen ? args.slice(objOpen, objEnd) : args.slice(objOpen);
        const hasSpread = /\.\.\./.test(payload);

        if (!/\bprompt\s*:/.test(payload) && !hasSpread)
            emit('warn', `${call[1]}(...) payload has no \`prompt\` — the reply carries no message`);

        // Accept the ES6 property SHORTHAND too: `{ prompt, sessionID, requestID }`.
        const hasSessionID = keyRe('sessionID').test(payload);
        const hasLowerSessionId = keyRe('sessionId').test(payload);
        if (hasLowerSessionId)
            emit('error', `${call[1]}(...) payload uses \`sessionId:\` (lowercase) — the write key is \`sessionID\` (uppercase ID); a lowercase key is silently dropped`);
        else if (!hasSessionID && !hasSpread)
            emit('error', `${call[1]}(...) reply has no \`sessionID\` — the agent resolves its trigger session-scoped, so an un-stamped reply is invisible → "No tool response". Stamp \`sessionID: toolOptions.agentNode.flowContext.sessionId\` (or the captured caller session)`);

        const hasRequestID = keyRe('requestID').test(payload);
        if (keyRe('requestId').test(payload) && !hasRequestID)
            emit('warn', `${call[1]}(...) payload uses \`requestId:\` (lowercase) — the write key is \`requestID\` (uppercase ID)`);
        else if (hasSessionID && !hasRequestID && !hasSpread)
            emit('info', `${call[1]}(...) has no fresh \`requestID\` — recommended: \`requestID: Tools.generateUUID()\` (mirrors the engine's own recall)`);

        if (callerReqRe.test(payload))
            emit('error', `${call[1]}(...) stamps \`requestID\` with the CALLER's request id (toolOptions.agentNode.flowContext.requestId) — the agent compares the newest prompt's requestID against that very id to detect a reply; an equal id reads as "no reply" → "No tool response". Use \`requestID: Tools.generateUUID()\` (or omit it)`);

        if (call[1] === 'setAgentPrompt' && !hasSpread) {
            const roleOk = /(^|[{,])\s*role\s*:\s*['"]user['"]/.test(payload);
            const chatOk = /(^|[{,])\s*agentChat\s*:\s*true\b/.test(payload);
            if (!roleOk || !chatOk)
                emit('error', `setAgentPrompt(...) reply is not a user trigger — the agent resolves its trigger as \`role: 'user'\` + \`agentChat: true\` (+ sessionID); add both (or use setRootAgentPrompt, which bakes them)`);
        }

        // nuance: flowContext.sessionId for a TOOL reply is the tool's OWN session, not the caller's
        if (/\bsessionID\s*:\s*flowContext\.sessionId\b/.test(payload) && opts.isTool)
            emit('warn', `${call[1]}(...) stamps \`sessionID: flowContext.sessionId\` — for a script TOOL that is the tool's OWN session, not the caller's. Reply with \`toolOptions.agentNode.flowContext.sessionId\`. (flowContext.sessionId is correct only when SEEDING an inner agent in a flow tool.)`);
    }

    // ── 6. tool scripts should read the caller from toolOptions ───────────────
    if (opts.isTool && sawReply) {
        if (!/\btoolContext\b/.test(src))
            emit('warn', 'script tool replies but never references `toolOptions.toolContext` — how does it get the caller (agentId / the `!*context`)?');
        else if (!/\bagentId\b/.test(src))
            emit('warn', 'script tool replies but never reads an `agentId` — which agent does it answer?');
        if (!/agentNode\s*\.\s*flowContext\s*\.\s*sessionId/.test(src)
            && !/flowContext\s*\.\s*sessionId/.test(src)
            && !/dictionary\s*\.\s*\w*[Ss]ession/.test(src)
            && !/\bsessionID\s*:/.test(src))
            emit('warn', 'script tool replies but never reads a caller session (`toolOptions.agentNode.flowContext.sessionId` or a captured one) — replies may be un-stamped');
    }
}

module.exports = { lintScript, SYSTEM_MODULES, stripComments, blankLiterals, checkBalance, parseImportClause };
