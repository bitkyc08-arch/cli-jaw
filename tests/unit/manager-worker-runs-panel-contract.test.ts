import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(root, path), 'utf8');
}

test('worker runs client consumes durable run APIs and unwraps safe envelopes', () => {
    const client = read('public/manager/src/workers/worker-runs-client.ts');

    assert.ok(client.includes('/api/orchestrate/worker-runs'), 'client must list durable worker runs through Manager API');
    assert.ok(client.includes('/api/orchestrate/worker-runs/${encodeURIComponent(runId)}/events'), 'client must read safe event timeline by runId');
    assert.ok(client.includes('/api/orchestrate/worker-runs/${encodeURIComponent(runId)}/output'), 'client must keep raw output behind explicit output API');
    assert.ok(client.includes('Promise<WorkerRunRecord[]>'), 'client must expose typed run records');
    assert.ok(client.includes('return body.runs;'), 'client must unwrap { runs }');
    assert.ok(client.includes('return body.events;'), 'client must unwrap { events }');
    assert.ok(client.includes('return body.output;'), 'client must unwrap { output }');
    assert.equal(client.includes('outputFile'), false, 'frontend worker-run contract must not expose local output file paths');
});

test('useWorkerRuns reuses existing worker SSE bridge and keeps raw output out of hydration', () => {
    const hook = read('public/manager/src/workers/useWorkerRuns.ts');

    assert.ok(hook.includes('subscribeToWorkerProgressEvents'), 'hook must reuse existing frontend worker event subscription');
    assert.ok(hook.includes("reason.startsWith('worker_run_')"), 'worker_run events must refresh durable runs');
    assert.ok(hook.includes("reason === 'replay_gap'"), 'replay gaps must refresh durable runs');
    assert.ok(hook.includes('client.listRuns()'), 'hook must hydrate recent runs');
    assert.ok(hook.includes('client.getRunEvents(runId)'), 'hook must load safe events on demand');
    assert.ok(hook.includes('client.readRunOutput(runId, input)'), 'hook must expose raw output only through explicit loadOutput');

    const mountEffect = hook.slice(hook.indexOf('useEffect(() => {'), hook.indexOf("return { runs, loading"));
    assert.equal(mountEffect.includes('readRunOutput'), false, 'mount/SSE refresh effects must not read raw output');
});

test('WorkerRunsPanel expands safe events and loads raw output only from explicit button action', () => {
    const panel = read('public/manager/src/workers/WorkerRunsPanel.tsx');
    const css = read('public/manager/src/workers/worker-runs.css');
    const monitor = read('public/manager/src/workers/WorkerProgressMonitorPanel.tsx');
    const main = read('public/manager/src/main.tsx');

    assert.ok(panel.includes('aria-label="Worker runs"'), 'panel must expose worker-runs semantics');
    assert.ok(panel.includes('visibleRuns = runs.slice(0, 8)'), 'panel must cap visible run rows');
    assert.ok(panel.includes('void loadEvents(run.runId)'), 'expanding a run must load safe events');
    assert.ok(panel.includes('Load output'), 'raw output must require a visible explicit action');
    assert.ok(panel.includes('void loadOutput(run.runId, { offset: 0 })'), 'initial output load must be button-triggered');
    assert.ok(panel.includes('Load next chunk'), 'raw output viewer must support bounded continuation');
    assert.ok(panel.includes('offset: output.nextOffset'), 'next chunk must use the server cursor');
    assert.ok(monitor.includes('<WorkerRunsPanel />'), 'progress monitor must include worker runs panel');
    assert.ok(main.includes("import './workers/worker-progress-monitor.css';"), 'Manager entry must import worker monitor CSS outside code.css');
    assert.ok(main.includes("import './workers/worker-runs.css';"), 'Manager entry must import worker runs CSS outside code.css');
    assert.ok(css.includes('.code-worker-run-list'), 'worker runs list must be styled');
    assert.ok(css.includes('max-height: min(34vh, 340px);'), 'worker run list must be bounded');
    assert.ok(css.includes('.code-worker-run-events'), 'safe event timeline must be styled');
    assert.ok(css.includes('max-height: 160px;'), 'safe event timeline must be bounded');
    assert.ok(css.includes('.code-worker-output'), 'raw output viewer must be styled');
    assert.ok(css.includes('max-height: 180px;'), 'raw output viewer must be bounded');
});

test('worker runs monitor remains Manager-local and independent of Code sessions', () => {
    const combined = [
        read('public/manager/src/workers/worker-runs-client.ts'),
        read('public/manager/src/workers/useWorkerRuns.ts'),
        read('public/manager/src/workers/WorkerRunsPanel.tsx'),
    ].join('\n');
    const router = read('public/manager/src/SidebarRailRouter.tsx');

    assert.ok(router.includes('<WorkerProgressMonitorPanel />'), 'SidebarRailRouter must render the monitor in Manager navigation');
    assert.equal(combined.includes('selectedInstance'), false, 'worker runs panel must not depend on selected child Jaw instance');
    assert.equal(combined.includes('CodeSession'), false, 'worker runs panel must not model runs as Code sessions');
    assert.equal(combined.includes('/api/code'), false, 'worker runs panel must not call Code session APIs');
    assert.equal(combined.includes('/api/bgtask'), false, 'worker runs panel must not call background task APIs');
    assert.equal(combined.includes('3465'), false, 'worker runs panel must not hardcode child Jaw ports');
});
