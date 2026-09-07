// ── Public employee progress contracts ──
// Employee runs broadcast internal-audience only; the web UI used to paint
// employee work exclusively via interaction-triggered snapshot hydration
// ("no render until click"). The parent-mirror tool append now also publishes
// the SAME sanitized entry on the SSE bus.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const spawnSrc = readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
const wsSrc = readFileSync(join(__dirname, '../../public/js/ws.ts'), 'utf8');

test('EPP-001: parent mirror publishes the sanitized employee tool on the SSE bus only', () => {
    const fn = spawnSrc.slice(
        spawnSrc.indexOf('function appendParentLiveRunTool('),
        spawnSrc.indexOf('function emitKiroStreamEvents('),
    );
    assert.ok(fn.includes("ssePublish('agent', 'agent_tool', { ...safeTool, isEmployee: true })"),
        'the sanitized mirror entry must reach the public SSE lane');
    assert.ok(fn.indexOf('sanitizeWorkerProgressTools') < fn.indexOf('ssePublish'),
        'only the sanitized tool may be published');
    assert.ok(!fn.includes("broadcast('agent_tool'"),
        'must use ssePublish, not broadcast — internal listeners already got the raw tool from the call site');
});

test('EPP-002: employee mirror events do not adopt the live run on the client', () => {
    const toolBlock = wsSrc.slice(wsSrc.indexOf("msg.type === 'agent_tool'"), wsSrc.indexOf("msg.type === 'agent_output'"));
    assert.ok(toolBlock.includes('if (msg.isEmployee !== true) adoptLiveRun(toolRunId)'),
        'adopting the employee run id would reset the boss textLen cursor mid-stream');
});

test('EPP-003: tool-seq cursor memory is raised and pins the live boss run', () => {
    assert.match(wsSrc, /TOOL_SEQ_RUN_MEMORY = 64/, 'employee runs multiply run-id cardinality — 16 evicted the boss cursor');
    const evict = wsSrc.slice(wsSrc.indexOf('function rememberAppliedToolSeq('), wsSrc.indexOf('function maxAppliedToolSeq('));
    assert.ok(evict.includes('key !== liveTraceRunId'), 'eviction must skip the live boss run');
});

test('EPP-004: the public mirror payload is sanitized — no thinking, capped detail', async () => {
    const { sanitizeWorkerProgressTools } = await import('../../src/orchestrator/worker-progress.ts');
    const sanitized = sanitizeWorkerProgressTools([
        { toolType: 'thinking', label: 'secret chain of thought', detail: 'x'.repeat(500) },
        { toolType: 'tool', label: 'Bash', detail: 'y'.repeat(500), status: 'running' },
    ]);
    assert.equal(sanitized.length, 1, 'thinking entries must be filtered from the public mirror');
    assert.ok((sanitized[0]?.detail || '').length <= 240, 'detail must stay capped at 240 chars');
});
