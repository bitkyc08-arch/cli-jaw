import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { MessageItem, ToolLogEntry } from '../../src/shared/chat-events.js';
import {
    GOLDEN_SVG_ICON,
    TOOL_DETAIL_SECRET,
    TRACE_RUN_ID,
    assistantMessage,
    explicitToolLog,
    liveToolLog,
    oversizedDetail,
    toolLogGoldenCases,
} from '../fixtures/dashboard2/tool-log-golden.js';

const vanillaLog = await import('../../public/js/features/process-log-adapter.js');
const portLog = await import('../../public/dashboard2/src/turn-stream/adapters/process-log-adapter.js');
const vanillaMatch = await import('../../public/js/features/process-step-match.js');
const portMatch = await import('../../public/dashboard2/src/turn-stream/adapters/process-step-match.js');
const detailSummary = await import('../../public/dashboard2/src/turn-stream/store/detail-summary.js');

// Parity normalizer removes only `id`, the UUID generated independently by each
// module invocation. `startTime` stays in the comparison because tests inject a
// fixed runStartedAt; every other ProcessStep field is compared by deepEqual.
function stableSteps(steps: Array<{ id: string }>): Array<Record<string, unknown>> {
    return steps.map(({ id: _id, ...step }) => step);
}

for (const fixture of toolLogGoldenCases) {
    test(`golden parse parity: ${fixture.name}`, () => {
        const vanillaParsed = vanillaLog.parseToolLog(fixture.raw);
        const portParsed = portLog.parseToolLog(fixture.raw);
        assert.equal(portParsed.length, fixture.expectedLength, fixture.name);
        assert.deepEqual(portParsed, vanillaParsed, fixture.name);
    });
}

test('message normalization matches the frozen vanilla adapter', () => {
    assert.deepEqual(
        portLog.normalizeMessageToolLog(assistantMessage),
        vanillaLog.normalizeMessageToolLog(assistantMessage),
    );
    const userMessage: MessageItem = { role: 'user', content: 'hello', tool_log: '[]' };
    assert.deepEqual(portLog.normalizeMessageToolLog(userMessage), vanillaLog.normalizeMessageToolLog(userMessage));
});

test('step conversion and explicit/live merge retain vanilla behavior', () => {
    const tools = portLog.parseToolLog(toolLogGoldenCases[0]!.raw);
    assert.deepEqual(
        stableSteps(portLog.toProcessSteps(tools, 1_700_000_000_000)),
        stableSteps(vanillaLog.toProcessSteps(tools, 1_700_000_000_000)),
    );
    assert.deepEqual(
        portLog.mergeExplicitAndLiveToolLogs(explicitToolLog, liveToolLog),
        vanillaLog.mergeExplicitAndLiveToolLogs(explicitToolLog, liveToolLog),
    );
});

test('identity matching converges same trace and keeps different trace identities separate', () => {
    const running = portLog.toProcessSteps([{
        icon: GOLDEN_SVG_ICON,
        label: 'compile',
        toolType: 'tool',
        status: 'running',
        traceRunId: TRACE_RUN_ID,
        traceSeq: 31,
    }], 100)[0]!;
    const done = { ...running, id: 'done', status: 'done' as const };
    assert.deepEqual(portMatch.sameProcessStepIdentity(running, done), vanillaMatch.sameProcessStepIdentity(running, done));
    assert.deepEqual(
        portMatch.findProcessStepByIdentity([running], done),
        vanillaMatch.findProcessStepByIdentity([running], done),
    );
    assert.deepEqual(
        portMatch.findLegacyRunningMatch([running], done),
        vanillaMatch.findLegacyRunningMatch([running], done),
    );
    assert.deepEqual(
        portMatch.findRunningProcessStepMatch([running], done),
        vanillaMatch.findRunningProcessStepMatch([running], done),
    );
    const rows = [running];
    const match = portMatch.findRunningProcessStepMatch(rows, done);
    assert.equal(match, running);
    if (match) Object.assign(match, done);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, 'done');

    const differentTrace = { ...done, id: 'other', traceSeq: 32 };
    assert.equal(portMatch.findRunningProcessStepMatch(rows, differentTrace), null);
    rows.push(differentTrace);
    assert.equal(rows.length, 2);
});

test('oversized full detail demotes through preview to a secret-free smaller summary', () => {
    const full = {
        tier: 'full' as const,
        label: 'exec',
        status: 'done' as const,
        detail: oversizedDetail,
        detailRef: { traceRunId: TRACE_RUN_ID, traceSeq: 43 },
    };
    const preview = detailSummary.detailToPreview(full, 512);
    const summary = detailSummary.previewToSummary(preview);
    assert.equal(preview.tier, 'preview');
    assert.equal(preview.truncated, true);
    assert.equal(summary.tier, 'summary');
    assert.deepEqual(summary.detailRef, full.detailRef);
    const serialized = JSON.stringify(summary);
    assert.equal(serialized.includes(TOOL_DETAIL_SECRET), false);
    assert.equal(serialized.includes(oversizedDetail), false);
    assert.ok(detailSummary.estimateDetailBytes(serialized) < detailSummary.estimateDetailBytes(JSON.stringify(full)));
});

test('summary aggregation is deterministic and carries no raw detail', () => {
    const summaries = [
        detailSummary.detailToSummary({ tier: 'full', label: 'zeta', status: 'error', detail: 'x\ny', detailRef: null }),
        detailSummary.detailToSummary({ tier: 'full', label: 'alpha', status: 'done', detail: 'ok', detailRef: null }),
        detailSummary.detailToSummary({ tier: 'full', label: 'alpha', status: 'running', detail: '', detailRef: null }),
    ];
    assert.deepEqual(detailSummary.aggregateDetailSummaries(summaries), {
        count: 3,
        running: 1,
        done: 1,
        error: 1,
        lineCount: 3,
        detailBytes: 5,
        label: 'alpha ×2, zeta',
    });
});

test('pure ports keep canonical imports type-only and expose no server retention contract', async () => {
    const files = [
        'public/dashboard2/src/turn-stream/adapters/process-step-match.ts',
        'public/dashboard2/src/turn-stream/adapters/process-log-adapter.ts',
        'public/dashboard2/src/turn-stream/store/detail-summary.ts',
    ];
    const source = (await Promise.all(files.map(file => readFile(file, 'utf8')))).join('\n');
    assert.doesNotMatch(source, /public\/manager\/src\/types|public\/js\//);
    assert.doesNotMatch(source, /\b(?:messageLimit|retentionDays|Database\.RunResult|MessagesPageResponse|SegmentedMessageItem|TurnLifecycleSsePayload)\b/);
    assert.doesNotMatch(source, /import\s*\{[^}]*\b(?:MessageItem|ToolLogEntry|TurnSegmentDetailRef)\b[^}]*\}\s*from/);
    assert.doesNotMatch(source, /\b(?:window|document|fetch|react)\b/);
});

test('sanitized entry helpers remain parity-compatible', () => {
    const entries: ToolLogEntry[] = [{ icon: GOLDEN_SVG_ICON, label: 'x', detail: 'ok', toolType: 'tool' }];
    assert.deepEqual(portLog.sanitizedToolLogEntries(entries), vanillaLog.sanitizedToolLogEntries(entries));
    assert.equal(portLog.sanitizedToolLogJsonFromEntries(entries), vanillaLog.sanitizedToolLogJsonFromEntries(entries));
});
