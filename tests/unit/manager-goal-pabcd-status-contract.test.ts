import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(root, path), 'utf8');
}

test('goal PABCD status client reads only the Manager-local status route', () => {
    const client = read('public/manager/src/goal-status/goal-pabcd-status-client.ts');
    const hook = read('public/manager/src/goal-status/useGoalPabcdStatus.ts');

    assert.ok(client.includes('/api/manager/runtime-status'), 'status client must use the Manager-local runtime status route');
    assert.ok(client.includes('goal PABCD status read failed'), 'status client must report JSON/API failures clearly');
    assert.ok(hook.includes("event.startsWith('goal_')"), 'goal lifecycle events must refresh status');
    assert.ok(hook.includes("event === 'orc_state'"), 'PABCD phase events must refresh status');
    assert.ok(hook.includes("event === 'heartbeat_pending'"), 'heartbeat pending events must refresh status');
    assert.ok(hook.includes("frame['topic'] === 'worker'"), 'worker runtime changes must refresh status');
    assert.ok(hook.includes("frame['topic'] === 'system' && event === 'replay_gap'"), 'replay gaps must refresh status');
});

test('goal PABCD status panel exposes goal, phase gate, runtime, and evidence surfaces', () => {
    const panel = read('public/manager/src/goal-status/GoalPabcdStatusPanel.tsx');
    const css = read('public/manager/src/goal-status/goal-pabcd-status.css');
    const cssEntry = read('public/manager/src/code/code.css');

    assert.ok(panel.includes('aria-label="Goal and PABCD status"'), 'panel must expose monitor semantics');
    assert.ok(panel.includes('Goal / PABCD'), 'panel must label the combined goal/PABCD status');
    assert.ok(panel.includes('snapshot?.pabcd.gate.status'), 'panel must show phase gate status');
    assert.ok(panel.includes('snapshot?.goal?.evidenceFreshness'), 'panel must show goal evidence freshness');
    assert.ok(panel.includes('runtime.activeWorkers'), 'panel must show worker runtime pressure');
    assert.ok(panel.includes('heartbeatPending'), 'panel must show heartbeat pending state');
    assert.ok(panel.includes('Gate evidence'), 'panel must show PABCD gate evidence detail');
    assert.ok(panel.includes('Goal evidence'), 'panel must show goal checkpoint evidence detail');
    assert.ok(css.includes('.code-goal-status-panel'), 'panel CSS must be defined');
    assert.ok(css.includes('@media (max-width: 760px)'), 'panel CSS must include compact responsive behavior');
    assert.equal(read('public/manager/src/code/CodeWorkbench.tsx').includes('<GoalPabcdStatusPanel />'), false, 'Code session transcript lane must not inline the status panel');
    assert.ok(cssEntry.includes("@import '../goal-status/goal-pabcd-status.css';"), 'Code CSS entry must import status panel CSS');
});

test('goal PABCD status surface stays independent of child Jaw instances', () => {
    const combined = [
        read('public/manager/src/goal-status/goal-pabcd-status-client.ts'),
        read('public/manager/src/goal-status/useGoalPabcdStatus.ts'),
        read('public/manager/src/goal-status/GoalPabcdStatusPanel.tsx'),
        read('src/manager/routes/runtime-monitor.ts'),
    ].join('\n');

    assert.equal(combined.includes('selectedInstance'), false, 'status surface must not depend on selected manager instance');
    assert.equal(combined.includes('/i/'), false, 'status surface must not proxy through child instance previews');
    assert.equal(combined.includes('/api/code'), false, 'status surface must not call Code session APIs');
    assert.equal(combined.includes('/api/dashboard/instances'), false, 'status surface must not read child instance list');
    assert.equal(combined.includes('3465'), false, 'status surface must not hardcode child Jaw ports');
});
