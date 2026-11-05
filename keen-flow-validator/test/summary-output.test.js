// The Summarizer is a flow step with In, Fallback, Out — the Summary output rule and the Summarizer node. Runs the JS reference and (on linux-x64) the prebuilt Go binary on the same
// generated project and checks that both give the same verdict. Run: node --test test/*.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MESSAGE = 'Summary output must connect to exactly one Summarizer node.';
const MODEL_MESSAGE = 'A Summarizer node needs a model.';
const IN_MESSAGE = "A Summarizer node's In takes only a Summary output or a Summarizer's Fallback.";
const FALLBACK_MESSAGE = "A Summarizer node's Fallback connects only to a Summarizer node.";
const LOOP_MESSAGE = 'Summarizer Fallbacks must not form a loop.';
const UNCONNECTED = 'Summarizer node is not connected to any Summary output';
const VALIDATE_JS = path.join(__dirname, '..', 'validate.js');
const GO_BIN = path.join(__dirname, '..', '..', 'bin', 'keen-validate-linux-amd64');
const HAVE_GO_BIN = process.platform === 'linux' && process.arch === 'x64' && fs.existsSync(GO_BIN);

const ids = { start: 'startNode_aaaaaaaaaaaa', main: 'agentNode_bbbbbbbbbbbb', sum: 'summarizerNode_cccccccccccc', sum2: 'summarizerNode_dddddddddddd', sum3: 'summarizerNode_iiiiiiiiiiii', main2: 'agentNode_gggggggggggg', oldSum: 'agentNode_hhhhhhhhhhhh', end: 'endNode_eeeeeeeeeeee', script: 'scriptNode_ffffffffffff' };

function agent(id, agentId, extra = {}) {
    return {
        id, type: 'agentNode', position: { x: 0, y: 0 },
        data: {
            label: '', description: '', labelNode: 'LLM', descriptionNode: 'Use LLM processor', open: false, openLLM: false, openPrompt: false,
            settings: {
                sessionId: '', requestId: '', agentId, agentName: agentId.toUpperCase().replace(/-/g, ' '),
                llm: { company: 'openai', model: extra.model || 'gpt-4o-mini', parameters: { temperature: 1, maxTokens: 1500, ...(extra.parameters || {}) } },
                specialRules: extra.specialRules || [],
                prompts: [{ id: 'p1', role: 'system', content: 'x' }]
            }
        },
        dragHandle: '.drag-handle__custom'
    };
}
function summarizer(id, extra = {}) {
    const settings = { prompts: [{ id: 'p1', role: 'system', content: 'Summarize.' }] };
    if (extra.llm !== null) settings.llm = { company: 'openai', model: extra.model || 'gpt-4o-mini', parameters: { temperature: 0.2, maxTokens: 1500, ...(extra.parameters || {}) }, ...(extra.llm || {}) };
    return {
        id, type: 'summarizerNode', position: { x: 0, y: 0 },
        data: { label: '', description: '', labelNode: 'Summarizer', descriptionNode: "Writes the chat summary for an LLM node's Summary output", open: false, settings },
        dragHandle: '.drag-handle__custom'
    };
}
const start = { id: ids.start, type: 'startNode', position: { x: 0, y: 0 }, data: { label: 'Start', description: '', labelNode: 'Start Flow', descriptionNode: 'Flow entry point', open: false, settings: { value: 'Start', label: 'Start' } }, dragHandle: '.drag-handle__custom' };
const end = { id: ids.end, type: 'endNode', position: { x: 0, y: 0 }, data: { label: 'End', description: '', labelNode: 'End Flow', descriptionNode: 'Flow terminal', open: false, settings: { value: 'End', label: 'End', terminateDictionary: false } }, dragHandle: '.drag-handle__custom' };
const script = { id: ids.script, type: 'scriptNode', position: { x: 0, y: 0 }, data: { label: 'S', description: '', labelNode: 'Script', descriptionNode: 'Execute custom JS script', open: false, settings: { value: 'init.js', label: 'S' } }, dragHandle: '.drag-handle__custom' };
let n = 0;
const edge = (source, sourceHandle, target, targetHandle = 'in') => ({ type: 'step', source, sourceHandle, target, targetHandle, id: `e${n++}` });
const base = () => [edge(ids.start, 'next', ids.main), edge(ids.main, 'next_1', ids.end), edge(ids.main, 'error', ids.end)];

function project(nodes, edges) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keen-validate-summary-'));
    fs.mkdirSync(path.join(dir, 'src', 'flows'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'flows', 'Chat.flow'), JSON.stringify({ nodes, edges }));
    fs.writeFileSync(path.join(dir, 'src', 'scripts', 'init.js'), 'export const exec = (props) => ({ ok: true });\n');
    fs.writeFileSync(path.join(dir, 'src', 'keen-tools.json'), '[]');
    return dir;
}

function run(nodes, edges) {
    const dir = project(nodes, edges);
    try {
        const out = { js: spawnSync('node', [VALIDATE_JS, dir], { encoding: 'utf8' }) };
        if (HAVE_GO_BIN) out.go = spawnSync(GO_BIN, [dir], { encoding: 'utf8' });
        return out;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// Both builds must agree: same exit code and same text.
function check(nodes, edges, expect) {
    const r = run(nodes, edges);
    const js = r.js.stdout;
    expect(js, r.js.status);
    if (r.go) {
        assert.strictEqual(r.go.status, r.js.status, 'Go exit code == JS');
        assert.strictEqual(r.go.stdout, js, 'Go output == JS output');
    }
}

test('no summary edge: fine, no summary finding', () => {
    check([start, agent(ids.main, 'main-agent'), end], base(), (out, code) => {
        assert.strictEqual(code, 0);
        assert.ok(!out.includes(MESSAGE));
    });
});

test('one summary edge to a Summarizer: fine, no agentId / agentName needed, Out / Fallback may stay unwired', () => {
    check([start, agent(ids.main, 'main-agent'), summarizer(ids.sum), end], [...base(), edge(ids.main, 'summary', ids.sum)], (out, code) => {
        assert.strictEqual(code, 0, out);
        assert.ok(!out.includes(MESSAGE) && !out.includes(MODEL_MESSAGE) && !out.includes(IN_MESSAGE), out);
        assert.ok(!out.includes('not wired'), out);
        assert.ok(!out.includes('not reachable'), out);
        assert.ok(!out.includes('agentId'), out);
        assert.ok(!out.includes('unknown node.type'), out);
        assert.ok(!out.includes('labelNode'), out);
    });
});

test('two LLM nodes may share one Summarizer', () => {
    const second = agent(ids.main2, 'second-agent');
    check([start, agent(ids.main, 'main-agent'), second, summarizer(ids.sum), end],
        [...base(), edge(ids.main, 'next_1', ids.main2), edge(ids.main2, 'next_1', ids.end), edge(ids.main2, 'error', ids.end),
            edge(ids.main, 'summary', ids.sum), edge(ids.main2, 'summary', ids.sum)], (out, code) => {
            assert.strictEqual(code, 0, out);
            assert.ok(!out.includes(MESSAGE) && !out.includes('single-in'), out);
        });
});

test('two summary edges: error with the exact words', () => {
    check([start, agent(ids.main, 'main-agent'), summarizer(ids.sum), summarizer(ids.sum2), end],
        [...base(), edge(ids.main, 'summary', ids.sum), edge(ids.main, 'summary', ids.sum2)], (out, code) => {
            assert.strictEqual(code, 1);
            assert.ok(out.includes(MESSAGE), out);
            assert.ok(out.includes(ids.main));
        });
});

test('a summary edge to an agentNode is refused now', () => {
    check([start, agent(ids.main, 'main-agent'), agent(ids.oldSum, 'summarizer'), end], [...base(), edge(ids.main, 'summary', ids.oldSum)], (out, code) => {
        assert.strictEqual(code, 1);
        assert.ok(out.includes(MESSAGE), out);
    });
});

test('a summary edge to a node that is not a Summarizer: error with the exact words', () => {
    check([start, agent(ids.main, 'main-agent'), script, end], [...base(), edge(ids.main, 'summary', ids.script)], (out, code) => {
        assert.strictEqual(code, 1);
        assert.ok(out.includes(MESSAGE), out);
    });
});

test('a summary edge to a missing node: error', () => {
    check([start, agent(ids.main, 'main-agent'), end], [...base(), edge(ids.main, 'summary', ids.sum)], (out, code) => {
        assert.strictEqual(code, 1);
        assert.ok(out.includes(MESSAGE), out);
    });
});

test('a Summarizer reached by a Summary output without a model: error', () => {
    for (const llm of [null, { model: '' }, { company: '' }]) {
        check([start, agent(ids.main, 'main-agent'), summarizer(ids.sum, { llm }), end], [...base(), edge(ids.main, 'summary', ids.sum)], (out, code) => {
            assert.strictEqual(code, 1, out);
            assert.ok(out.includes(MODEL_MESSAGE), out);
            assert.ok(out.includes(ids.sum), out);
        });
    }
});

test('a Summarizer with an Out edge is fine (it continues like any node)', () => {
    check([start, agent(ids.main, 'main-agent'), summarizer(ids.sum), end], [...base(), edge(ids.main, 'summary', ids.sum), edge(ids.sum, 'next_1', ids.end)], (out, code) => {
        assert.strictEqual(code, 0, out);
        assert.ok(!out.includes('not valid on summarizerNode') && !out.includes(IN_MESSAGE), out);
    });
});

test('a Summarizer Out may lead anywhere: no check against the LLM node Out', () => {
    check([start, agent(ids.main, 'main-agent'), summarizer(ids.sum), script, end],
        [edge(ids.start, 'next', ids.main), edge(ids.main, 'next_1', ids.end), edge(ids.main, 'error', ids.end), edge(ids.main, 'summary', ids.sum), edge(ids.sum, 'next_1', ids.script), edge(ids.script, 'next_1', ids.end), edge(ids.script, 'error', ids.end)], (out, code) => {
            assert.strictEqual(code, 0, out);
        });
});

test('a Fallback chain of Summarizers (model failover) is fine', () => {
    check([start, agent(ids.main, 'main-agent'), summarizer(ids.sum), summarizer(ids.sum2), end],
        [...base(), edge(ids.main, 'summary', ids.sum), edge(ids.sum, 'error', ids.sum2), edge(ids.sum, 'next_1', ids.end), edge(ids.sum2, 'next_1', ids.end)], (out, code) => {
            assert.strictEqual(code, 0, out);
            assert.ok(!out.includes('not connected') && !out.includes('not reachable'), out);
        });
});

test('a Fallback target Summarizer without a model: error', () => {
    check([start, agent(ids.main, 'main-agent'), summarizer(ids.sum), summarizer(ids.sum2, { llm: null }), end],
        [...base(), edge(ids.main, 'summary', ids.sum), edge(ids.sum, 'error', ids.sum2)], (out, code) => {
            assert.strictEqual(code, 1, out);
            assert.ok(out.includes(MODEL_MESSAGE) && out.includes(ids.sum2), out);
        });
});

test('a Fallback to a node that is not a Summarizer: error', () => {
    check([start, agent(ids.main, 'main-agent'), summarizer(ids.sum), end], [...base(), edge(ids.main, 'summary', ids.sum), edge(ids.sum, 'error', ids.end)], (out, code) => {
        assert.strictEqual(code, 1);
        assert.ok(out.includes(FALLBACK_MESSAGE) && out.includes(ids.sum), out);
    });
});

test('a Fallback to an LLM node: error', () => {
    check([start, agent(ids.main, 'main-agent'), summarizer(ids.sum), end], [...base(), edge(ids.main, 'summary', ids.sum), edge(ids.sum, 'error', ids.main)], (out, code) => {
        assert.strictEqual(code, 1);
        assert.ok(out.includes(FALLBACK_MESSAGE), out);
    });
});

test('two Fallback edges: error', () => {
    check([start, agent(ids.main, 'main-agent'), summarizer(ids.sum), summarizer(ids.sum2), summarizer(ids.sum3), end],
        [...base(), edge(ids.main, 'summary', ids.sum), edge(ids.sum, 'error', ids.sum2), edge(ids.sum, 'error', ids.sum3)], (out, code) => {
            assert.strictEqual(code, 1);
            assert.ok(out.includes(FALLBACK_MESSAGE), out);
        });
});

test('Fallbacks that loop: error with the exact words (two and one node)', () => {
    check([start, agent(ids.main, 'main-agent'), summarizer(ids.sum), summarizer(ids.sum2), end],
        [...base(), edge(ids.main, 'summary', ids.sum), edge(ids.sum, 'error', ids.sum2), edge(ids.sum2, 'error', ids.sum)], (out, code) => {
            assert.strictEqual(code, 1);
            assert.ok(out.includes(LOOP_MESSAGE), out);
        });
    check([start, agent(ids.main, 'main-agent'), summarizer(ids.sum), end],
        [...base(), edge(ids.main, 'summary', ids.sum), edge(ids.sum, 'error', ids.sum)], (out, code) => {
            assert.strictEqual(code, 1);
            assert.ok(out.includes(LOOP_MESSAGE), out);
        });
});

test('a Summarizer In from a script node: error', () => {
    check([start, agent(ids.main, 'main-agent'), summarizer(ids.sum), script, end],
        [...base(), edge(ids.main, 'summary', ids.sum), edge(ids.script, 'next_1', ids.sum)], (out, code) => {
            assert.strictEqual(code, 1);
            assert.ok(out.includes(IN_MESSAGE) && out.includes(ids.sum), out);
        });
});

test('a Summarizer In from an LLM node Out (not Summary): error', () => {
    check([start, agent(ids.main, 'main-agent'), summarizer(ids.sum), end], [...base(), edge(ids.main, 'summary', ids.sum), edge(ids.main, 'next_1', ids.sum)], (out, code) => {
        assert.strictEqual(code, 1);
        assert.ok(out.includes(IN_MESSAGE), out);
    });
});

test('a Summarizer no Summary output reaches: a warning, not an error', () => {
    check([start, agent(ids.main, 'main-agent'), summarizer(ids.sum), end], base(), (out, code) => {
        assert.strictEqual(code, 0, out);
        assert.ok(out.includes(UNCONNECTED), out);
        assert.ok(!out.includes('not reachable'), out);
    });
});

test('a reasoning Summarizer is a warning, not an error', () => {
    check([start, agent(ids.main, 'main-agent'), summarizer(ids.sum, { model: 'gpt-5.4-mini', parameters: { reasoningEffort: 'high' } }), end],
        [...base(), edge(ids.main, 'summary', ids.sum)], (out, code) => {
            assert.strictEqual(code, 0, out);
            assert.ok(out.includes('reasoning'), out);
        });
});

test('reasoning effort none / low is not warned', () => {
    check([start, agent(ids.main, 'main-agent'), summarizer(ids.sum, { model: 'gpt-5.4-mini', parameters: { reasoningEffort: 'none' } }), end],
        [...base(), edge(ids.main, 'summary', ids.sum)], (out, code) => {
            assert.strictEqual(code, 0, out);
            assert.ok(!out.includes('reasoning'), out);
        });
});

test('a source node without history is warned', () => {
    check([start, agent(ids.main, 'main-agent', { specialRules: [{ type: 'skip-internal-database-interactions' }] }), summarizer(ids.sum), end],
        [...base(), edge(ids.main, 'summary', ids.sum)], (out, code) => {
            assert.strictEqual(code, 0, out);
            assert.ok(out.includes('skip-internal-database-interactions'), out);
        });
});

test('summary is not a handle of other node types', () => {
    check([start, agent(ids.main, 'main-agent'), script, end], [...base(), edge(ids.script, 'summary', ids.main)], (out, code) => {
        assert.strictEqual(code, 1);
        assert.ok(out.includes('sourceHandle "summary" is not valid on scriptNode'), out);
    });
});

test('a Summarizer has only the `in` handle', () => {
    check([start, agent(ids.main, 'main-agent'), summarizer(ids.sum), end], [...base(), edge(ids.main, 'summary', ids.sum, 'next_1')], (out, code) => {
        assert.strictEqual(code, 1);
        assert.ok(out.includes('targetHandle "next_1" is not valid on summarizerNode'), out);
    });
});

test('a Summarizer with the wrong type / id prefix is caught like any node', () => {
    const bad = { ...summarizer(ids.sum), type: 'agentNode' };
    check([start, agent(ids.main, 'main-agent'), bad, end], [...base(), edge(ids.main, 'summary', ids.sum)], (out, code) => {
        assert.strictEqual(code, 1);
        assert.ok(out.includes('disagrees with id prefix'), out);
    });
});
