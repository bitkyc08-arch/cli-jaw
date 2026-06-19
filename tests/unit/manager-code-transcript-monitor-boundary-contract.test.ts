import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(root, path), 'utf8');
}

test('Code workbench transcript lane does not inline global runtime monitors', () => {
    const workbench = read('public/manager/src/code/CodeWorkbench.tsx');

    assert.equal(workbench.includes('GoalPabcdStatusPanel'), false, 'goal/PABCD monitor must not render inside Code session transcript lane');
    assert.equal(workbench.includes('BackgroundTaskMonitorPanel'), false, 'background task monitor must not render inside Code session transcript lane');
    assert.equal(workbench.includes('WorkerProgressMonitorPanel'), false, 'worker progress monitor must not render inside Code session transcript lane');

    assert.ok(workbench.includes('<CodeWorkspaceHeader'), 'Code workbench must keep session/worktree context header');
    assert.ok(workbench.includes('<CodeTranscript'), 'Code workbench must keep transcript as the central scroll lane');
    assert.ok(workbench.includes('<CodeComposer'), 'Code workbench must keep composer in the bottom dock');
    assert.ok(workbench.includes('<ComposerFooter'), 'Code workbench must keep provider/model/permission controls near composer');
});

test('Code CSS entry does not import Manager monitor stylesheets (slice 211 boundary)', () => {
    const css = read('public/manager/src/code/code.css');
    for (const monitorCss of [
        "@import '../goal-status/goal-pabcd-status.css';",
        "@import '../background-tasks/background-task-monitor.css';",
        "@import '../workers/worker-progress-monitor.css';",
    ]) {
        assert.equal(css.includes(monitorCss), false, `code.css must not import monitor CSS: ${monitorCss}`);
    }
});

test('runtime monitor components remain Manager-local and independent of Code sessions', () => {
    const monitorSources = [
        read('public/manager/src/goal-status/GoalPabcdStatusPanel.tsx'),
        read('public/manager/src/background-tasks/BackgroundTaskMonitorPanel.tsx'),
        read('public/manager/src/workers/WorkerProgressMonitorPanel.tsx'),
        read('public/manager/src/goal-status/goal-pabcd-status-client.ts'),
        read('public/manager/src/background-tasks/background-task-client.ts'),
        read('public/manager/src/workers/worker-progress-client.ts'),
    ].join('\n');

    assert.ok(monitorSources.includes('/api/manager/runtime-status'), 'goal monitor remains backed by Manager runtime status');
    assert.ok(monitorSources.includes('/api/bgtask'), 'background monitor remains backed by Manager background task APIs');
    assert.ok(monitorSources.includes('/api/orchestrate/worker-progress'), 'worker monitor remains backed by Manager worker progress APIs');
    assert.equal(monitorSources.includes('/api/code/sessions'), false, 'runtime monitors must not read Code session state');
    assert.equal(monitorSources.includes('selectedInstance'), false, 'runtime monitors must not depend on selected child Jaw instance');
});
