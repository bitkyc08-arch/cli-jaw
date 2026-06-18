import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(root, path), 'utf8');
}

test('Code mode receives global ACP child exit events without requiring active session scoped payloads', () => {
    const events = read('public/manager/src/code/useCodeEvents.ts');

    assert.ok(events.includes("const isGlobalCodeEvent = data.event === 'code_child_exit'"), 'child exit must be classified as a global Code event');
    assert.ok(events.includes('if (!sid && !isGlobalCodeEvent) return;'), 'global child exit must still reach Code mode without an active session id');
    assert.ok(events.includes('if (!isGlobalCodeEvent && data.sessionId && data.sessionId !== sid) return;'), 'session-scoped events must keep session filtering');
});

test('CodeCanvas surfaces ACP child exit as recovery state instead of silent streaming deadlock', () => {
    const canvas = read('public/manager/src/code/CodeCanvas.tsx');
    const workbench = read('public/manager/src/code/CodeWorkbench.tsx');
    const css = read('public/manager/src/code/code.css');

    assert.ok(canvas.includes("kind === 'code_child_exit'"), 'CodeCanvas must handle child exit events');
    assert.ok(canvas.includes('JWC ACP child exited'), 'recovery copy must identify the ACP child failure');
    assert.ok(canvas.includes('setActiveSessionId(null)'), 'dead child must clear active session so next prompt creates a fresh session');
    assert.ok(canvas.includes('setSending(false)'), 'dead child must stop streaming state');
    assert.ok(canvas.includes('setPermissions([])'), 'dead child must clear stale permission prompts');
    assert.ok(canvas.includes('setChildRecovery({ code, message })'), 'child exit must drive visible recovery banner state');
    assert.ok(canvas.includes('setChildRecovery(null);'), 'new prompt/cwd reset must clear stale recovery banner');
    assert.ok(workbench.includes('props.childRecovery'), 'CodeWorkbench must render child recovery state');
    assert.ok(workbench.includes('role="status"'), 'recovery banner must be announced as status');
    assert.ok(css.includes('.code-child-recovery'), 'recovery banner must have dedicated styles');
});

