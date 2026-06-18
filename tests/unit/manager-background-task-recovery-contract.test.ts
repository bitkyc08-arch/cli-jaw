import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    BackgroundTaskApiError,
    createBackgroundTaskClient,
} from '../../public/manager/src/background-tasks/background-task-client.ts';

const root = join(import.meta.dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(root, path), 'utf8');
}

test('background task client preserves duplicate existingId from 409 responses', async () => {
    const client = createBackgroundTaskClient({
        fetchImpl: async () => new Response(JSON.stringify({
            error: 'an active background task already covers this work (bg_existing)',
            existingId: 'bg_existing',
        }), { status: 409, headers: { 'content-type': 'application/json' } }),
    });

    await assert.rejects(
        client.createTask({
            kind: 'shell',
            spec: {
                command: ['node', '-e', 'setInterval(() => {}, 1000)'],
                completion: { type: 'exit' },
                promptTemplate: 'done {{result}}',
            },
        }),
        (err: unknown) => err instanceof BackgroundTaskApiError
            && err.status === 409
            && err.existingId === 'bg_existing',
    );
});

test('background task hook maps duplicate task failures to a user-readable message', () => {
    const hook = read('public/manager/src/background-tasks/useBackgroundTasks.ts');

    assert.ok(hook.includes('err instanceof BackgroundTaskApiError'), 'hook must inspect API errors');
    assert.ok(hook.includes('err.status === 409 && err.existingId'), 'hook must identify duplicate background task errors');
    assert.ok(hook.includes('Already running as ${err.existingId}'), 'duplicate message must name the existing task');
});

test('background task monitor surfaces recovery and notification state', () => {
    const panel = read('public/manager/src/background-tasks/BackgroundTaskMonitorPanel.tsx');
    const css = read('public/manager/src/background-tasks/background-task-monitor.css');

    assert.ok(panel.includes('recoveryNote'), 'panel must centralize recovery/notification wording');
    assert.ok(panel.includes("task.status === 'orphaned'"), 'panel must explain orphaned tasks');
    assert.ok(panel.includes('lost during server restart'), 'panel must surface restart-loss failures');
    assert.ok(panel.includes('Completion notification is pending recovery delivery.'), 'panel must show pending notification delivery');
    assert.ok(panel.includes('Completion notification sent'), 'panel must show notified terminal tasks');
    assert.ok(panel.includes('code-bg-task-recovery-note'), 'panel must render recovery note UI');
    assert.ok(css.includes('.code-bg-task-recovery-note'), 'recovery note must be styled');
    assert.ok(css.includes('.code-bg-task-recovery-note.is-orphaned'), 'orphaned note must be visually distinct');
});

test('background task monitor recovery UI stays out of Electron replacement paths', () => {
    const combined = [
        read('public/manager/src/background-tasks/BackgroundTaskMonitorPanel.tsx'),
        read('public/manager/src/background-tasks/useBackgroundTasks.ts'),
        read('public/manager/src/background-tasks/background-task-client.ts'),
    ].join('\n');

    assert.equal(combined.includes('electron:dist:mac'), false, 'monitor must not invoke Electron packaging');
    assert.equal(combined.includes('/Applications/cli-jaw.app'), false, 'monitor must not reference installed app replacement');
    assert.equal(combined.includes('24577'), false, 'monitor must not bind to Electron Manager port');
});
