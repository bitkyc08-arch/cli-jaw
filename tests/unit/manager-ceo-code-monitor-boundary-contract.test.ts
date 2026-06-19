import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(root, path), 'utf8');
}

test('Jaw CEO console owns orchestration control, not Code runtime monitor panels', () => {
    const ceoConsole = read('public/manager/src/jaw-ceo/JawCeoConsole.tsx');
    const ceoPanels = read('public/manager/src/jaw-ceo/JawCeoConsolePanels.tsx');
    const ceoHook = read('public/manager/src/jaw-ceo/useJawCeo.ts');
    const ceoApi = read('public/manager/src/jaw-ceo/api.ts');
    const combined = [ceoConsole, ceoPanels, ceoHook, ceoApi].join('\n');

    assert.ok(ceoConsole.includes('data-surface-owner="ceo-orchestration-control"'), 'CEO console must mark its orchestration-control surface owner');
    assert.ok(combined.includes('continueCompletion'), 'CEO must own completion continuation actions');
    assert.ok(combined.includes('summarizeCompletion'), 'CEO must own completion summary actions');
    assert.ok(combined.includes('ackCompletion'), 'CEO must own completion acknowledgment actions');
    assert.ok(combined.includes('/api/jaw-ceo'), 'CEO must use the Jaw CEO control API');
    assert.equal(combined.includes('GoalPabcdStatusPanel'), false, 'CEO must not render the Code goal/PABCD monitor');
    assert.equal(combined.includes('BackgroundTaskMonitorPanel'), false, 'CEO must not render the Code background task monitor');
    assert.equal(combined.includes('WorkerProgressMonitorPanel'), false, 'CEO must not render the Code worker progress monitor');
    assert.equal(combined.includes('/api/manager/runtime-status'), false, 'CEO must not read the Code runtime status monitor API');
    assert.equal(combined.includes('/api/bgtask'), false, 'CEO must not own background task monitor APIs');
    assert.equal(combined.includes('/api/orchestrate/worker-progress'), false, 'CEO must not own worker progress monitor APIs');
});

test('runtime observability monitors stay Manager-local and out of the Code session transcript lane', () => {
    const workbench = read('public/manager/src/code/CodeWorkbench.tsx');
    const goalPanel = read('public/manager/src/goal-status/GoalPabcdStatusPanel.tsx');
    const backgroundPanel = read('public/manager/src/background-tasks/BackgroundTaskMonitorPanel.tsx');
    const workerPanel = read('public/manager/src/workers/WorkerProgressMonitorPanel.tsx');
    const statusClient = read('public/manager/src/goal-status/goal-pabcd-status-client.ts');
    const backgroundClient = read('public/manager/src/background-tasks/background-task-client.ts');
    const workerClient = read('public/manager/src/workers/worker-progress-client.ts');
    const combined = [workbench, goalPanel, backgroundPanel, workerPanel, statusClient, backgroundClient, workerClient].join('\n');

    assert.equal(workbench.includes('<GoalPabcdStatusPanel />'), false, 'Code session transcript lane must not inline the goal/PABCD runtime monitor');
    assert.equal(workbench.includes('<BackgroundTaskMonitorPanel />'), false, 'Code session transcript lane must not inline the background task runtime monitor');
    assert.equal(workbench.includes('<WorkerProgressMonitorPanel />'), false, 'Code session transcript lane must not inline the worker runtime monitor');
    assert.ok(goalPanel.includes('data-monitor-owner="code-runtime-observability"'), 'goal monitor must mark Code runtime observability ownership');
    assert.ok(backgroundPanel.includes('data-monitor-owner="code-runtime-observability"'), 'background monitor must mark Code runtime observability ownership');
    assert.ok(workerPanel.includes('data-monitor-owner="code-runtime-observability"'), 'worker monitor must mark Code runtime observability ownership');
    assert.ok(statusClient.includes('/api/manager/runtime-status'), 'Code goal/PABCD monitor must read Manager runtime status');
    assert.ok(backgroundClient.includes('/api/bgtask'), 'Code background monitor must read background task APIs');
    assert.ok(workerClient.includes('/api/orchestrate/worker-progress'), 'Code worker monitor must read worker progress APIs');
    assert.equal(combined.includes('/api/jaw-ceo'), false, 'Code runtime monitors must not call Jaw CEO control APIs');
    assert.equal(combined.includes('sendJawCeoMessage'), false, 'Code runtime monitors must not send CEO messages');
    assert.equal(combined.includes('continueJawCeoCompletion'), false, 'Code runtime monitors must not own CEO continuation actions');
});
