'use strict';

/**
 * node-spec.js — the canonical spec for every Keen flow node type, extracted from the
 * flow canvas source + the engine node logic. This is the SINGLE SOURCE OF
 * TRUTH the validator checks against. Keep it in lockstep with:
 *   - the flow canvas node components   (handles, fixed labels, form rules)
 *   - the engine node logic             (routing keys the handlers read)
 *   - the deploy build step             (ms-deploy builder/flow-compiler.ts)
 *
 * Two kinds of rule live here. ENGINE rules mirror what the engines / the deploy
 * compiler actually enforce. CANVAS rules mirror the Shira canvas forms — they are
 * STRICTER than the engines (e.g. letters-only labels, no `${…}` in a Run Flow target,
 * ≤10 key/value pairs) and exist so an authored project is also editable on the canvas.
 * Both are enforced; the README says which is which.
 */

/** The 14 node type strings (node-types.ts). */
const NODE_TYPES = [
    'startNode', 'endNode', 'conditionNode', 'loopNode', 'runFlowNode', 'jumpFlowNode',
    'joinNode', 'assignmentNode', 'scriptNode', 'agentNode', 'parallelInNode',
    'parallelFlowNode', 'parallelContextNode', 'noteNode'
];

/**
 * Per-type spec:
 *   labelNode / descriptionNode  — the FIXED card title/subtitle (must be exactly this)
 *   sources    — the source (out) handle ids that may appear as an edge sourceHandle
 *   targets    — the target (in) handle ids that may appear as an edge targetHandle
 *   multiIn    — target handles that accept MORE THAN ONE incoming edge
 *   requiredOut— out handles that SHOULD be wired (unwired => the branch dead-ends)
 *   recommendOut — out handles that are optional but recommended (e.g. error/fallback)
 *   width      — canvas card width in px (cosmetic; for reference)
 */
const SPEC = {
    startNode: {
        labelNode: 'Start Flow', descriptionNode: 'Flow entry point',
        sources: ['next'], targets: [], multiIn: [],
        requiredOut: ['next'], recommendOut: [], width: 170
    },
    endNode: {
        labelNode: 'End Flow', descriptionNode: 'Flow terminal',
        sources: [], targets: ['in'], multiIn: ['in'],
        requiredOut: [], recommendOut: [], width: 170
    },
    conditionNode: {
        labelNode: 'Condition', descriptionNode: 'Set condition flow direction',
        sources: ['true', 'false'], targets: ['in'], multiIn: [],
        requiredOut: ['true', 'false'], recommendOut: [], width: 170
    },
    loopNode: {
        labelNode: 'Loop', descriptionNode: 'Loop dictionary iterable segment',
        sources: ['out', 'next_1'], targets: ['in', 'next_2'], multiIn: ['in'],
        requiredOut: ['out', 'next_1'], recommendOut: [], width: 170
    },
    runFlowNode: {
        labelNode: 'Run Flow', descriptionNode: 'Execute Flow in this context and return',
        sources: ['next_1'], targets: ['in'], multiIn: ['in'],
        requiredOut: ['next_1'], recommendOut: [], width: 170
    },
    jumpFlowNode: {
        labelNode: 'Jump Flow', descriptionNode: 'Execute Flow in this context and continue',
        sources: [], targets: ['in'], multiIn: ['in'],
        requiredOut: [], recommendOut: [], width: 170
    },
    joinNode: {
        labelNode: 'Join Flow', descriptionNode: 'Common merge point',
        sources: ['next_1'], targets: ['in'], multiIn: ['in'],
        requiredOut: ['next_1'], recommendOut: [], width: 170
    },
    assignmentNode: {
        labelNode: 'Assignment', descriptionNode: 'Set properties to the current dictionary',
        sources: ['next_1'], targets: ['in'], multiIn: [],
        requiredOut: ['next_1'], recommendOut: [], width: 170
    },
    scriptNode: {
        labelNode: 'Script', descriptionNode: 'Execute custom JS script',
        sources: ['error', 'next_1'], targets: ['in'], multiIn: ['in'],
        requiredOut: ['next_1'], recommendOut: ['error'], width: 170
    },
    agentNode: {
        labelNode: 'LLM', descriptionNode: 'Use LLM processor',
        sources: ['error', 'next_1'], targets: ['in'], multiIn: ['in'],
        requiredOut: ['next_1'], recommendOut: ['error'], width: 170
    },
    parallelInNode: {
        labelNode: 'Parallel Flows', descriptionNode: 'Execute many flows in parallel with private context',
        sources: ['next_1'], targets: ['in', 'wait'], multiIn: ['in', 'wait'],
        requiredOut: ['next_1'], recommendOut: [], width: 170
    },
    parallelFlowNode: {
        labelNode: 'Flow Pointer', descriptionNode: 'Point to the flow that must be awaited',
        sources: ['next'], targets: [], multiIn: [],
        requiredOut: ['next'], recommendOut: [], width: 170
    },
    parallelContextNode: {
        labelNode: 'Parallel Context',
        descriptionNode: 'Point to the single flow that must be awaited with predefined context',
        sources: ['next_1'], targets: ['in'], multiIn: [],
        requiredOut: ['next_1'], recommendOut: [], width: 200
    },
    noteNode: {
        labelNode: 'Note', descriptionNode: 'Write your notes here',
        sources: [], targets: [], multiIn: [],
        requiredOut: [], recommendOut: [], width: 500
    }
};

/** The `wait` handle only accepts edges FROM these node types (App.tsx onlyFrom). */
const WAIT_ONLY_FROM = ['parallelFlowNode'];

/**
 * What actually happens when a recommended failure edge is NOT wired — it differs per
 * engine, so the warning text is per type:
 *   - scriptNode: script-engine routes a throw to `error`; with no `error` edge it emits
 *     `nodeTasks: []` and the flow STALLS (script-run-mgr.ts, "stalls the flow deliberately").
 *   - agentNode: llms-engine prefers the `error` (Fallback) edge on a provider failure;
 *     with none it CONTINUES on `next_1` with the error text as the answer (llm-run-mgr.ts).
 */
const RECOMMEND_OUT_MSG = {
    scriptNode: {
        error: 'scriptNode "error" edge is not wired — a script throw has no handler and the flow STALLS (wire it to an End node or a handler)'
    },
    agentNode: {
        error: 'agentNode "error" (Fallback) edge is not wired — on a provider failure the flow continues on next_1 with the error text AS the answer (wire it to handle failures explicitly)'
    }
};

/**
 * LLM providers the llms-engine can actually dispatch (llm-orchestrator-mgr.ts switch:
 * anthropic / openai / google). Compared case-insensitively after trim (model-registry
 * normalizeProvider lowercases). Anything else throws E6101 "Unsupported LLM provider".
 */
const LLM_PROVIDERS = ['anthropic', 'openai', 'google'];

/** Field-format regexes / caps enforced by the canvas forms. */
const RULES = {
    startLabel: /^[A-Z][a-zA-Z]*$/,               // one capitalized word, letters only (CANVAS; ms-space also allows digits)
    flowFileName: /^[A-Z][A-Za-z0-9]*$/,          // PascalCase file name (letters+digits) = ms-space startFlow rule
    fileLabel: /^[A-Z][a-zA-Z]*-[A-Z][a-zA-Z]*$/, // Run/Jump/Flow-Pointer/ParallelContext.pipe target (CANVAS)
    agentId: /^[a-z]+(-[a-z]+)*$/,                // kebab-case, letters only (CANVAS; the engine also resolves ${…})
    dictRef: /^(\$\{)?dictionary\..+/,            // loop/parallelContext dictionary reference (ENGINE parsePath)
    dictOrSessionRef: /^(\$\{)?(dictionary|session)\..+/, // loop value/setto (ENGINE parsePath)
    placeholder: /\$\{(dictionary|session)\.[^}]+\}/g,
    startLabelMax: 60, descriptionMax: 250, noteMax: 160,
    kvMaxPairs: 10, kvKeyMax: 100, kvValueMax: 200,
    agentNameMin: 4, agentNameMax: 60, scriptPathMax: 160
};

/** Node id prefix → type (the engine derives kind from the id prefix; `parallelContext` is the engine kind). */
function typeFromId(id) {
    for (const t of NODE_TYPES) {
        // parallelContextNode id prefix is `parallelContextNode_`; substring match is fine.
        if (typeof id === 'string' && id.startsWith(t + '_')) return t;
    }
    return null;
}

module.exports = {
    NODE_TYPES, SPEC, WAIT_ONLY_FROM, RECOMMEND_OUT_MSG, LLM_PROVIDERS, RULES, typeFromId
};
