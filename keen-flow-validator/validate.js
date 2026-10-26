#!/usr/bin/env node
'use strict';

/**
 * validate.js — a deterministic static validator for a Keen flow project.
 *
 *   node validate.js <project-dir>
 *
 * Checks a project's `.flow` files, scripts, and keen-tools.json against the documented
 * contracts (node-spec.js) BEFORE deploy — catching the silent failures that otherwise
 * only surface at runtime as "No tool response", a stalled flow, or a rejected deploy.
 *
 * Exit code: 0 = no errors (warnings allowed), 1 = at least one error, 2 = usage/IO error.
 *
 * The Go binary in go-validate/ is a rule-for-rule port of this file; keep them in lockstep.
 */

const fs = require('fs');
const path = require('path');
const { SPEC, WAIT_ONLY_FROM, RECOMMEND_OUT_MSG, LLM_PROVIDERS, RULES, typeFromId } = require('./node-spec');
const { lintScript } = require('./script-lint');

// ─── finding accumulator ────────────────────────────────────────────────────
const findings = [];
function err(file, where, msg) { findings.push({ level: 'error', file, where, msg }); }
function warn(file, where, msg) { findings.push({ level: 'warn', file, where, msg }); }
function info(file, where, msg) { findings.push({ level: 'info', file, where, msg }); }

// ─── JSON helpers (mirror the Go port's defensive accessors) ────────────────
/** A non-empty string, else ''. */
function str(v) { return typeof v === 'string' ? v : ''; }
/** The first non-empty string among the values, else ''. */
function firstStr(...vals) { for (const v of vals) if (typeof v === 'string' && v !== '') return v; return ''; }
/** A plain object (not array/null), else null. */
function asMap(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
function isNum(v) { return typeof v === 'number'; }
/** JSON text of a value; `undefined` prints as `null` (matches Go's json of a missing key). */
function jsonish(v) { return v === undefined ? 'null' : JSON.stringify(v); }
/** Byte-order string compare (matches Go's `<` on strings). */
function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

// ─── project loading ─────────────────────────────────────────────────────────
function loadProject(root) {
    const src = path.join(root, 'src');
    const flowsDir = path.join(src, 'flows');
    const scriptsDir = path.join(src, 'scripts');
    const toolsPath = path.join(src, 'keen-tools.json');

    const flowFiles = [];
    let extensionLayout = false;
    const structure = []; // [where, msg] — the ms-deploy structure-gate consequences

    if (!fs.existsSync(flowsDir)) {
        err('project', 'src/flows', 'missing src/flows directory');
    } else {
        // The deploy builds flows/ in place and then requires: single level, only .js left,
        // ≥1 *.flow.js (ms-deploy structure-scanner.ts + build-project.ts). A stray file or
        // a subfolder survives the build and the whole deploy is rejected.
        const entries = fs.readdirSync(flowsDir, { withFileTypes: true }).sort((a, b) => cmp(a.name, b.name));
        for (const e of entries) {
            if (e.isDirectory()) structure.push(`subfolder "${e.name}" — flows/ must be a single level; the deploy structure gate rejects it ("flows must be a single level (no subfolders)")`);
            else if (!e.name.endsWith('.flow')) {
                structure.push(`stray file "${e.name}" — only .flow files may live in src/flows; it survives the build and the deploy is rejected ("flows must contain only .js files")`);
                if (e.name.endsWith('.flow.json')) extensionLayout = true;
            } else flowFiles.push(e.name);
        }
        if (flowFiles.length === 0) structure.push('no .flow files — the deploy build rejects the project ("flows/ contains no .flow files")');
    }
    if (fs.existsSync(path.join(root, 'keen-tools.json'))) extensionLayout = true;
    // A VS Code-extension project (src/flows/*.flow.json + per-flow folders + root
    // keen-tools.json) is built by keen-builder into dist/ — it never ships src/ raw, so its
    // layout "violations" are one WARN, not N errors. A .flow project gets each as an ERROR.
    if (extensionLayout)
        warn('project', '', `VS Code-extension project layout detected (src/flows/*.flow.json and/or a root keen-tools.json) — this validator checks the ms-deploy format (src/flows/*.flow + src/keen-tools.json { "tools": [...] }); flows are NOT validated here (${structure.length} layout item(s) that keen-deploy would reject if src/ were uploaded raw)`);
    else for (const m of structure) err('project', 'src/flows', m);
    // The deploy creates scripts/ (with debux.js) when it is absent, so this is only unusual.
    if (!fs.existsSync(scriptsDir)) warn('project', 'src/scripts', 'missing src/scripts directory — allowed (the deploy creates it), but a flow with Script nodes needs it');

    const scripts = new Set();  // *.js under src/scripts (linted)
    const allFiles = new Set(); // every file under src/scripts (relative-import targets)
    if (fs.existsSync(scriptsDir)) {
        const walk = d => fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => cmp(a.name, b.name)).forEach(e => {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else {
                const rel = path.relative(scriptsDir, p).split(path.sep).join('/');
                allFiles.add(rel);
                if (e.name.endsWith('.js')) scripts.add(rel);
            }
        });
        walk(scriptsDir);
    }

    let tools = null;
    let toolsPresent = false;
    if (fs.existsSync(toolsPath)) {
        try { tools = JSON.parse(fs.readFileSync(toolsPath, 'utf8')); toolsPresent = true; }
        catch (e) { err('keen-tools.json', '', `invalid JSON: ${e.message}`); }
    } else {
        warn('keen-tools.json', '', 'missing src/keen-tools.json (fine if the project declares no tools)');
    }
    return { root, flowsDir, scriptsDir, flowFiles, scripts, allFiles, tools: asMap(tools), toolsPresent };
}

// ─── flow parsing ──────────────────────────────────────────────────────────
function parseFlow(flowsDir, file) {
    let raw;
    try { raw = fs.readFileSync(path.join(flowsDir, file), 'utf8'); }
    catch (e) { err(file, '', `cannot read: ${e.message}`); return null; }
    let top;
    try { top = JSON.parse(raw); }
    catch (e) { err(file, '', `invalid JSON: ${e.message}`); return null; }

    const m = asMap(top);
    if (!m) { err(file, '', 'top level must be an object { nodes, edges }'); return null; }
    const doc = { nodes: [], edges: [] };
    if (Array.isArray(m.nodes)) doc.nodes = m.nodes; else err(file, '', '`nodes` must be an array');
    if (Array.isArray(m.edges)) doc.edges = m.edges; else warn(file, '', '`edges` missing or not an array — treating as []');
    for (const k of Object.keys(m).sort(cmp)) {
        if (k !== 'nodes' && k !== 'edges') warn(file, '', `unexpected top-level key "${k}" — the canvas keeps only { nodes, edges } and drops the rest`);
    }
    return doc;
}

// ─── per-node checks ─────────────────────────────────────────────────────────
function checkNode(file, nv) {
    const node = asMap(nv);
    if (!node) { err(file, '(node)', 'node is not an object'); return; }
    const id = str(node.id);
    if (!id) { err(file, '(node)', 'node has no string id'); return; }

    const typeFromPrefix = typeFromId(id) || '';
    const nodeType = str(node.type);
    if (!typeFromPrefix) err(file, id, `id prefix does not match any node type (expected "<type>_<12 chars>")`);
    if (!nodeType) err(file, id, 'node.type is missing');
    else if (!SPEC[nodeType]) err(file, id, `unknown node.type "${nodeType}"`);
    else if (typeFromPrefix && typeFromPrefix !== nodeType) err(file, id, `node.type "${nodeType}" disagrees with id prefix "${typeFromPrefix}_"`);

    const type = nodeType && SPEC[nodeType] ? nodeType : typeFromPrefix;
    const spec = type && SPEC[type];
    if (!spec) return;

    // id format
    const idBody = id.length > type.length + 1 ? id.slice(type.length + 1) : '';
    if (!/^[A-Za-z0-9]{12}$/.test(idBody)) warn(file, id, `id body "${idBody}" is not 12 A–Za–z0–9 chars (canvas generates 12)`);

    // dragHandle
    if (node.dragHandle !== '.drag-handle__custom') warn(file, id, `dragHandle should be ".drag-handle__custom" (got ${jsonish(node.dragHandle)})`);

    const data = asMap(node.data) || {};
    // fixed labels (CANVAS rule — the engine never reads them)
    if (str(data.labelNode) !== spec.labelNode) err(file, id, `data.labelNode must be "${spec.labelNode}" (got ${jsonish(data.labelNode)})`);
    if (str(data.descriptionNode) !== spec.descriptionNode) err(file, id, `data.descriptionNode must be "${spec.descriptionNode}" (got ${jsonish(data.descriptionNode)})`);

    // position
    const pos = asMap(node.position);
    if (!pos || !isNum(pos.x) || !isNum(pos.y)) warn(file, id, 'position {x,y} missing or non-numeric');

    checkNodeFields(file, id, type, asMap(data.settings) || {}, data);
}

/**
 * The Start label the DEPLOY sees: the compiler builds the entry map from
 * `settings.label` ONLY (ms-deploy builder/flow-compiler.ts getEntryFlowMap). The canvas
 * writes both `label` and `value`; a hand-authored `value`-only start registers nothing.
 */
function startLabelOf(s) {
    const label = str(s.label);
    if (label) return { label, fromValue: false };
    const value = str(s.value);
    return { label: value, fromValue: value !== '' };
}

function checkNodeFields(file, id, type, s, data) {
    const R = RULES;
    switch (type) {
        case 'startNode': {
            const sl = startLabelOf(s);
            if (sl.fromValue) warn(file, id, `Start label read from settings.value "${sl.label}" — the deploy compiler builds the entry map from settings.label ONLY; add "label": "${sl.label}" to settings or this entry will not exist after deploy`);
            const label = sl.label;
            if (!label) err(file, id, 'Start node has no Label (settings.label) — it is the flow entry name');
            else if (!R.startLabel.test(label)) err(file, id, `Start label "${label}" must match ${R.startLabel} (one capitalized word, letters only)`);
            else if (label.length > R.startLabelMax) err(file, id, `Start label exceeds ${R.startLabelMax} chars`);
            break;
        }
        case 'conditionNode': {
            const expr = str(s.value);
            if (!expr) err(file, id, 'Condition has no expression (settings.value)');
            else {
                // The engine substitutes only ${dictionary.*}/${session.*}; anything left bare
                // parses as member access and throws. Strip the placeholders, then look.
                const bare = expr.replace(/\$\{[^}]*\}/g, ' ');
                if (/(^|[^\w.])(dictionary|session)\.\w/.test(bare))
                    err(file, id, `Condition uses a BARE "dictionary."/"session." — the engine throws "Member access is not allowed". Wrap it: \${dictionary.x} === true`);
                checkPlaceholders(file, id, expr);
            }
            break;
        }
        case 'loopNode': {
            for (const f of ['value', 'setto']) {
                const v = str(s[f]);
                if (!v) err(file, id, `Loop "${f === 'value' ? 'Read from' : 'Set to'}" is empty`);
                else if (!R.dictOrSessionRef.test(v)) err(file, id, `Loop "${f}" = ${JSON.stringify(v)} must be "dictionary.<path>" or "session.<key>" (bare name throws "invalid ${f}")`);
            }
            if (str(s.value) && str(s.value) === str(s.setto)) err(file, id, 'Loop Read from and Set to must differ');
            break;
        }
        case 'assignmentNode':
        case 'scriptNode': {
            checkKeyValuePairs(file, id, s);
            if (type === 'scriptNode') {
                const sp = str(s.value);
                if (!sp) err(file, id, 'Script node has no Script path (settings.value)');
                else {
                    if (!sp.endsWith('.js')) err(file, id, `Script path "${sp}" must end with .js`);
                    if (sp.length > R.scriptPathMax) err(file, id, `Script path exceeds ${R.scriptPathMax} chars`);
                }
            }
            break;
        }
        case 'runFlowNode':
        case 'jumpFlowNode':
        case 'parallelFlowNode': {
            const v = str(s.value);
            if (!v) err(file, id, `${type} has no Flow target (settings.value)`);
            else if (!RULES.fileLabel.test(v)) err(file, id, `Flow target "${v}" must be a File-Label (${RULES.fileLabel}) — the canvas form rejects digits and \${…}`);
            break;
        }
        case 'parallelContextNode': {
            const cc = str(s.contextCollection);
            if (!cc) err(file, id, 'Parallel Context has no Context Collection');
            else if (!RULES.dictRef.test(cc)) err(file, id, `contextCollection ${JSON.stringify(cc)} must start with "dictionary."`);
            const pipe = str(s.pipe);
            if (!pipe) err(file, id, 'Parallel Context has no Flow Pointer (settings.pipe)');
            else if (!RULES.fileLabel.test(pipe)) err(file, id, `pipe "${pipe}" must be a File-Label (${RULES.fileLabel})`);
            if (!str(s.assignTo)) warn(file, id, 'Parallel Context "Assign result" is empty — the form requires it (though the engine ignores it; read results from the collection)');
            break;
        }
        case 'agentNode': {
            const aid = str(s.agentId);
            if (!aid) err(file, id, 'Agent (LLM) node has no agentId');
            else if (!RULES.agentId.test(aid)) err(file, id, `agentId "${aid}" must be kebab-case letters-only (${RULES.agentId})`);
            const name = str(s.agentName);
            if (!name) err(file, id, 'Agent (LLM) node has no agentName');
            else if (name.length < RULES.agentNameMin || name.length > RULES.agentNameMax) warn(file, id, `agentName length should be ${RULES.agentNameMin}–${RULES.agentNameMax}`);
            const llm = asMap(s.llm);
            if (!llm) err(file, id, 'Agent (LLM) node has no settings.llm block (company/model/parameters)');
            else {
                const company = str(llm.company);
                if (!company) err(file, id, 'settings.llm.company missing — the LLM engine throws E6101 "Missing LLM configuration" without it');
                else if (!LLM_PROVIDERS.includes(company.trim().toLowerCase())) err(file, id, `settings.llm.company "${company}" is not a supported provider (${LLM_PROVIDERS.join(', ')}) — the LLM engine throws E6101 "Unsupported LLM provider"`);
                if (!str(llm.model)) err(file, id, 'settings.llm.model missing — the LLM engine throws E6101 without it (it must be a model name registered for the provider)');
            }
            if (Array.isArray(s.prompts)) {
                for (const pv of s.prompts) {
                    const pm = asMap(pv);
                    if (pm && typeof pm.content === 'string') checkPlaceholders(file, id, pm.content);
                }
            }
            break;
        }
        case 'noteNode': {
            const label = firstStr(data.label, s.value);
            if (label && label.length > RULES.noteMax) warn(file, id, `Note text exceeds ${RULES.noteMax} chars`);
            break;
        }
        default: break;
    }
}

function checkKeyValuePairs(file, id, s) {
    if (!('keyValuePairs' in s)) return;
    const pairs = s.keyValuePairs;
    if (!Array.isArray(pairs)) { err(file, id, 'settings.keyValuePairs must be an array'); return; }
    if (pairs.length > RULES.kvMaxPairs) err(file, id, `too many key/value pairs (${pairs.length} > ${RULES.kvMaxPairs})`);
    const seen = new Set();
    for (const pv of pairs) {
        const pm = asMap(pv);
        if (!pm || typeof pm.key !== 'string') { err(file, id, 'a key/value pair has no string key'); continue; }
        const key = pm.key;
        if (key.length > RULES.kvKeyMax) err(file, id, `pair key "${key}" exceeds ${RULES.kvKeyMax} chars`);
        if (typeof pm.value === 'string') {
            if (pm.value.length > RULES.kvValueMax) err(file, id, `pair "${key}" value exceeds ${RULES.kvValueMax} chars`);
            checkPlaceholders(file, id, pm.value);
        }
        if (seen.has(key)) err(file, id, `duplicate key "${key}" in key/value pairs`);
        seen.add(key);
    }
}

function checkPlaceholders(file, id, text) {
    // flag placeholder roots other than dictionary/session
    const re = /\$\{([a-zA-Z_]+)\./g;
    let m;
    while ((m = re.exec(String(text)))) {
        const root = m[1];
        if (root !== 'dictionary' && root !== 'session')
            warn(file, id, `placeholder \${${root}.…} — only \${dictionary.*} and \${session.*} resolve; "${root}" stays literal (throws in a Condition)`);
    }
}

// ─── per-edge + wiring checks ────────────────────────────────────────────────
function typeOf(nv) {
    const n = asMap(nv);
    if (!n) return '';
    const t = str(n.type);
    if (t && SPEC[t]) return t;
    return typeFromId(str(n.id)) || '';
}

function checkEdgesAndWiring(file, doc) {
    const nodes = doc.nodes;
    const byId = new Map();
    for (const nv of nodes) { const n = asMap(nv); const id = n ? str(n.id) : ''; if (id) byId.set(id, n); }

    // outgoing[node.id][handle] = [targets]
    const outByHandle = new Map();
    const inCount = new Map();      // target node id + handle → count

    for (const ev of doc.edges) {
        const e = asMap(ev);
        if (!e) { err(file, '(edge)', 'edge is not an object'); continue; }
        const source = str(e.source), target = str(e.target);
        const sourceHandle = str(e.sourceHandle), targetHandle = str(e.targetHandle);
        if (!byId.has(source)) err(file, '(edge)', `edge.source "${source}" is not a node in this flow`);
        if (!byId.has(target)) err(file, '(edge)', `edge.target "${target}" is not a node in this flow`);
        const et = str(e.type);
        if (et && et !== 'step') warn(file, '(edge)', `edge.type "${et}" — the canvas writes "step"`);

        const sType = typeOf(byId.get(source)), tType = typeOf(byId.get(target));

        if (sType && SPEC[sType]) {
            if (!sourceHandle) err(file, source, 'edge has no sourceHandle');
            else if (!SPEC[sType].sources.includes(sourceHandle))
                err(file, source, `sourceHandle "${sourceHandle}" is not valid on ${sType} (valid: ${SPEC[sType].sources.join(', ') || 'none'})`);
            else {
                if (!outByHandle.has(source)) outByHandle.set(source, {});
                (outByHandle.get(source)[sourceHandle] ||= []).push(target);
            }
        }
        if (tType && SPEC[tType]) {
            if (!targetHandle) err(file, target, 'edge has no targetHandle');
            else if (!SPEC[tType].targets.includes(targetHandle))
                err(file, target, `targetHandle "${targetHandle}" is not valid on ${tType} (valid: ${SPEC[tType].targets.join(', ') || 'none'})`);
            else {
                const k = `${target}::${targetHandle}`;
                inCount.set(k, (inCount.get(k) || 0) + 1);
                // multi-in check
                if (inCount.get(k) > 1 && !SPEC[tType].multiIn.includes(targetHandle))
                    err(file, target, `handle "${targetHandle}" on ${tType} is single-in but has ${inCount.get(k)} incoming edges`);
                // wait onlyFrom
                if (targetHandle === 'wait' && sType && !WAIT_ONLY_FROM.includes(sType))
                    err(file, target, `wait handle accepts only ${WAIT_ONLY_FROM.join('/')} sources (got ${sType})`);
            }
        }
    }

    // required / recommended out-handles
    for (const nv of nodes) {
        const n = asMap(nv);
        const id = n ? str(n.id) : '';
        if (!id) continue;
        const t = typeOf(n);
        const spec = t && SPEC[t];
        if (!spec) continue;
        const outs = outByHandle.get(id) || {};
        for (const h of spec.requiredOut) {
            if (!outs[h] || outs[h].length === 0) warn(file, id, `${t} out-handle "${h}" is not wired — that path dead-ends`);
        }
        for (const h of spec.recommendOut) {
            if (!outs[h] || outs[h].length === 0) {
                const msg = (RECOMMEND_OUT_MSG[t] && RECOMMEND_OUT_MSG[t][h]) || `${t} "${h}" edge is not wired — a failure here has no handler (wire it for robustness)`;
                warn(file, id, msg);
            }
        }
    }

    // reachability from any start node
    const reach = new Set();
    for (const nv of nodes) if (typeOf(nv) === 'startNode') { const id = str(asMap(nv).id); if (id) reach.add(id); }
    let grew = true;
    while (grew) {
        grew = false;
        for (const [src, handles] of outByHandle) {
            if (!reach.has(src)) continue;
            for (const targets of Object.values(handles)) for (const tgt of targets) if (!reach.has(tgt)) { reach.add(tgt); grew = true; }
        }
    }
    for (const nv of nodes) {
        const n = asMap(nv);
        const id = n ? str(n.id) : '';
        const t = typeOf(n);
        if (!id || t === 'startNode' || t === 'noteNode' || t === 'parallelFlowNode') continue;
        if (!reach.has(id)) warn(file, id, `${t} is not reachable from any Start node`);
    }
}

// ─── cross-file + tool registry ──────────────────────────────────────────────
function buildEntryRegistry(parsed) {
    // File-Label → file for every start node label (as the deploy compiler would build it)
    const registry = new Map();
    for (const { file, doc } of parsed) {
        const base = file.replace(/\.flow$/, '');
        if (!RULES.flowFileName.test(base)) err(file, '', `flow file name "${base}" must be PascalCase (${RULES.flowFileName})`);
        // ms-space accepts digits in a start-flow name, but every File-Label target is letters only.
        else if (/[0-9]/.test(base)) warn(file, '', `flow file name "${base}" has digits — it can be an agent's start flow, but no Run / Jump / Flow Pointer / Parallel Context node or flow tool can target it (a File-Label is letters only, ${RULES.fileLabel}); use letters only`);
        for (const nv of doc.nodes) {
            const n = asMap(nv);
            if (!n) continue;
            if (str(n.type) === 'startNode' || typeFromId(str(n.id)) === 'startNode') {
                const s = asMap(asMap(n.data)?.settings) || {};
                const label = startLabelOf(s).label;
                if (label && RULES.startLabel.test(label)) registry.set(`${base}-${label}`, file);
            }
        }
    }
    return registry;
}

function registryKeys(registry) { return [...registry.keys()].sort(cmp); }

function checkCrossFile(project, parsed, registry) {
    const known = registryKeys(registry).join(', ');
    for (const { file, doc } of parsed) {
        for (const nv of doc.nodes) {
            const n = asMap(nv);
            if (!n) continue;
            const id = str(n.id);
            const t = typeOf(n);
            const s = asMap(asMap(n.data)?.settings) || {};
            const target =
                (t === 'runFlowNode' || t === 'jumpFlowNode' || t === 'parallelFlowNode') ? str(s.value) :
                (t === 'parallelContextNode') ? str(s.pipe) : '';
            if (target && RULES.fileLabel.test(target) && !registry.has(target))
                err(file, id, `${t} target "${target}" does not resolve to any flow's Start (File-Label). Known entries: ${known || '(none)'}`);
            // scriptNode file existence
            if (t === 'scriptNode') {
                const v = str(s.value);
                if (v && !project.scripts.has(v)) err(file, id, `Script file "${v}" not found under src/scripts/`);
            }
        }
    }
}

function checkTools(project, registry) {
    if (!project.toolsPresent || !project.tools) return;
    const toolsArr = project.tools.tools;
    if (!Array.isArray(toolsArr)) { err('keen-tools.json', '', 'expected { "tools": [ … ] }'); return; }
    const names = new Set();
    for (const tv of toolsArr) {
        const tool = asMap(tv);
        const name = tool ? str(tool.name) : '';
        const label = name || '(unnamed)';
        if (!tool || typeof tool.name !== 'string') { err('keen-tools.json', label, 'tool has no string name'); continue; }
        if (names.has(name)) err('keen-tools.json', label, `duplicate tool name "${name}"`);
        names.add(name);
        const ttype = str(tool.type);
        if (ttype !== 'script' && ttype !== 'flow') { err('keen-tools.json', label, `tool.type must be "script" or "flow" (got ${jsonish(tool.type)})`); continue; }
        const entry = str(tool.entry);
        if (!entry) { err('keen-tools.json', label, 'tool.entry is missing'); continue; }
        if (ttype === 'script') {
            if (!entry.startsWith('tools/')) err('keen-tools.json', label, `script tool entry "${entry}" must start with "tools/"`);
            else if (entry.includes('..')) err('keen-tools.json', label, `script tool entry "${entry}" must not contain ".."`);
            else if (!project.scripts.has(entry)) err('keen-tools.json', label, `script tool entry "${entry}" not found under src/scripts/`);
        } else { // flow
            if (!RULES.fileLabel.test(entry)) err('keen-tools.json', label, `flow tool entry "${entry}" must be a File-Label (${RULES.fileLabel})`);
            else if (!registry.has(entry)) err('keen-tools.json', label, `flow tool entry "${entry}" does not resolve to any flow's Start`);
        }
    }
}

// ─── main ────────────────────────────────────────────────────────────────────
function main() {
    const root = process.argv[2];
    if (!root) { console.error('usage: node validate.js <project-dir>'); process.exit(2); }
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) { console.error(`no such directory: ${root}`); process.exit(2); }

    const project = loadProject(root);
    const parsed = [];
    for (const file of project.flowFiles) {
        const doc = parseFlow(project.flowsDir, file);
        if (!doc) continue;
        parsed.push({ file, doc });
        for (const n of doc.nodes) checkNode(file, n);
        checkEdgesAndWiring(file, doc);
    }
    const registry = buildEntryRegistry(parsed);
    checkCrossFile(project, parsed, registry);
    checkTools(project, registry);

    // ── script-contract lint ─────────────────────────────────────────────────
    // A script is a "tool" if a keen-tools.json script tool points at it.
    const toolScripts = new Set();
    if (project.toolsPresent && project.tools && Array.isArray(project.tools.tools)) {
        for (const tv of project.tools.tools) {
            const tm = asMap(tv);
            if (tm && str(tm.type) === 'script' && str(tm.entry)) toolScripts.add(tm.entry);
        }
    }
    // A script is an ENTRY when something actually runs it: a Script node points at
    // it, or a script tool is registered against it. Anything else is a helper module
    // imported by a relative path — a normal ES module that legitimately exports
    // functions and NO `exec` (see shira-flow-builder-guide/nodes/script-node.md,
    // "Importing one script from another").
    const nodeScripts = new Set();
    for (const { doc } of parsed) {
        for (const nv of doc.nodes) {
            const n = asMap(nv);
            if (n && typeOf(n) === 'scriptNode') {
                const v = str(asMap(asMap(n.data)?.settings)?.value);
                if (v) nodeScripts.add(v);
            }
        }
    }
    for (const rel of [...project.scripts].sort(cmp)) {
        if (rel === 'debux.js') {
            warn('scripts/debux.js', '', 'scripts/debux.js is engine-managed — the deploy injects its own copy over it and the scanner skips it; remove it from src/scripts (not linted)');
            continue;
        }
        let source;
        try { source = fs.readFileSync(path.join(project.scriptsDir, rel), 'utf8'); }
        catch (e) { err(`scripts/${rel}`, '', `cannot read: ${e.message}`); continue; }
        const isTool = toolScripts.has(rel);
        const isEntry = isTool || nodeScripts.has(rel);
        const label = isTool ? ' (tool)' : (isEntry ? '' : ' (helper)');
        const file = `scripts/${rel}${label}`;
        lintScript(source, (level, msg) => findings.push({ level, file, where: '', msg }), {
            isTool, isEntry, rel, exists: p => project.allFiles.has(p)
        });
    }

    // report
    const order = { error: 0, warn: 1, info: 2 };
    findings.sort((a, b) => order[a.level] - order[b.level] || cmp(a.file, b.file));
    const errs = findings.filter(f => f.level === 'error').length;
    const warns = findings.filter(f => f.level === 'warn').length;
    const infos = findings.filter(f => f.level === 'info').length;

    const tag = { error: '✗ ERROR', warn: '⚠ WARN ', info: 'ℹ INFO ' };
    for (const f of findings) console.log(`${tag[f.level]}  ${f.file}${f.where ? ' › ' + f.where : ''}\n           ${f.msg}`);

    const toolCount = project.toolsPresent && project.tools && Array.isArray(project.tools.tools) ? project.tools.tools.length : 0;
    console.log('\n──────────────────────────────────────────');
    console.log(`entries (File-Labels) found: ${registryKeys(registry).join(', ') || '(none)'}`);
    console.log(`flows: ${project.flowFiles.length} · scripts: ${project.scripts.size} · tools: ${toolCount}`);
    console.log(`${errs} error(s), ${warns} warning(s), ${infos} info`);
    process.exit(errs > 0 ? 1 : 0);
}

main();
