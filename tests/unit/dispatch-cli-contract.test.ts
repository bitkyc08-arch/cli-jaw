import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { unwrapEmployeeSummaries } from '../../bin/commands/dispatch-helpers.ts';

const projectRoot = join(import.meta.dirname, '../..');
const dispatchSrc = readFileSync(join(projectRoot, 'bin/commands/dispatch.ts'), 'utf8');

test('dispatch helper unwraps legacy employee arrays', () => {
    assert.deepEqual(
        unwrapEmployeeSummaries([{ id: '1', name: 'Frontend' }, { bad: true }]),
        [{ id: '1', name: 'Frontend' }],
    );
});

test('dispatch helper unwraps standard { ok, data } employee envelopes', () => {
    assert.deepEqual(
        unwrapEmployeeSummaries({ ok: true, data: [{ id: '2', name: 'Backend' }] }),
        [{ id: '2', name: 'Backend' }],
    );
});

test('dispatch helper returns an empty list for malformed employee payloads', () => {
    assert.deepEqual(unwrapEmployeeSummaries({ ok: true, data: { id: 'bad' } }), []);
    assert.deepEqual(unwrapEmployeeSummaries(null), []);
});

test('dispatch CLI resolves agent id from /api/employees only for watch or worker-busy polling', () => {
    // 260613 60: every dispatch is wait:false now — 202 + poll is the single
    // result path for both watch and quiet modes.
    const watchIdx = dispatchSrc.indexOf('if (res.status === 202)');
    assert.ok(watchIdx >= 0, '202 path should handle the async dispatch response');

    const nonOkIdx = dispatchSrc.indexOf('if (!res.ok)', watchIdx);
    assert.ok(nonOkIdx >= 0, 'dispatch.ts should handle non-ok dispatch responses');
    const nonOkBlock = dispatchSrc.slice(nonOkIdx, nonOkIdx + 2000);

    const status409Idx = nonOkBlock.indexOf('if (res.status === 409)');
    const resolveIdx = nonOkBlock.indexOf('await resolveAgentId(agent)');
    assert.ok(status409Idx >= 0, 'non-ok path should branch on HTTP 409 before polling');
    assert.ok(resolveIdx > status409Idx, 'resolveAgentId should only run inside the 409 branch');
    const watchBlock = dispatchSrc.slice(watchIdx, dispatchSrc.indexOf('if (!res.ok)', watchIdx));
    assert.ok(
        watchBlock.includes("body?.worker?.agentId || (agent ? await resolveAgentId(agent) : null)"),
        'watch 202 path should resolve agent id only for persisted employees if the server omits worker metadata',
    );
    assert.ok(
        dispatchSrc.includes('const parsed = await readJsonResponse<unknown>(res, \'employees endpoint\')'),
        'resolveAgentId should parse /api/employees through the safe JSON helper',
    );
    assert.ok(
        dispatchSrc.includes('unwrapEmployeeSummaries(parsed.body)'),
        'resolveAgentId should unwrap /api/employees envelope safely',
    );
});

test('dispatch CLI supports virtual employees without /api/employees fallback', () => {
    assert.ok(dispatchSrc.includes('--virtual <name>'), 'help should document --virtual');
    assert.ok(dispatchSrc.includes('--role <text>'), 'help should document --role');
    assert.ok(dispatchSrc.includes('--cli <name>'), 'help should document virtual --cli override');
    assert.ok(dispatchSrc.includes('--model <name>'), 'help should document virtual --model override');
    assert.ok(dispatchSrc.includes("const virtual = getFlag('--virtual')"), 'dispatch should parse --virtual');
    assert.ok(dispatchSrc.includes('...(agent ? { agent } : { virtual })'), 'request body should send agent or virtual');
    assert.ok(
        dispatchSrc.includes("body?.existing?.agentId || (agent ? await resolveAgentId(agent) : null)"),
        'worker-busy fallback should not call /api/employees for virtual employees',
    );
});

test('dispatch CLI reports stale or missing server routes for non-JSON responses', () => {
    assert.match(dispatchSrc, /async function readJsonResponse/);
    assert.match(dispatchSrc, /await res\.text\(\)/);
    assert.match(dispatchSrc, /JSON\.parse\(raw\)/);
    assert.match(dispatchSrc, /server may be stale or missing this route/);
    assert.doesNotMatch(dispatchSrc, /\.json\(\)/);
});

test('dispatch CLI prints worker-status recovery hints for initial fetch failures', () => {
    assert.ok(
        dispatchSrc.includes('function printFetchErrorWithRecovery'),
        'dispatch CLI should centralize fetch failure recovery guidance',
    );
    assert.ok(
        dispatchSrc.includes('cli-jaw worker status'),
        'dispatch CLI should tell users how to inspect possibly accepted workers after fetch failed',
    );
    assert.ok(
        dispatchSrc.includes('cli-jaw worker status "${targetName}"'),
        'dispatch CLI should include a target-specific worker status command',
    );
    const noResponseIdx = dispatchSrc.indexOf('if (!res)');
    assert.ok(noResponseIdx >= 0, 'dispatch CLI should handle missing initial response');
    const noResponseBlock = dispatchSrc.slice(noResponseIdx, dispatchSrc.indexOf('process.exit(1);', noResponseIdx));
    assert.ok(
        noResponseBlock.includes('printFetchErrorWithRecovery(errString(lastError))'),
        'initial request failures should print fetch recovery guidance before exiting',
    );
});

test('dispatch CLI preserves runId in poll recovery hints without auto-inlining raw output', () => {
    assert.ok(
        dispatchSrc.includes('function printPollErrorWithRecovery'),
        'poll failures should use a dedicated run-aware recovery helper',
    );
    assert.ok(
        dispatchSrc.includes('public readonly runId?: string'),
        'DispatchPollError should carry the per-run id when known',
    );
    assert.ok(
        dispatchSrc.includes('cli-jaw worker status ${e.runId}'),
        'poll recovery should point directly at the runId status surface',
    );
    assert.ok(
        dispatchSrc.includes('cli-jaw worker read ${e.runId} --tail 80'),
        'poll recovery should expose raw output only as an explicit worker read command',
    );
    assert.ok(
        dispatchSrc.includes('const pollRunId = body?.worker?.runId'),
        '202 polling should thread the server-provided runId into pollers',
    );
    assert.ok(
        dispatchSrc.includes('body?.worker?.runId || body?.existing?.runId'),
        '409 worker-busy polling should thread the existing runId into pollers',
    );
});
