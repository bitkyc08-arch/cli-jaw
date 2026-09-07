import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getCompletionItems } from '../../src/cli/commands.ts';
import { normalizeTuiWsEvent } from '../../src/cli/tui/events.ts';
import { buildAppearanceRows, nextAppearancePatch } from '../../src/cli/tui/settings-screen.ts';

test('TUI completion exposes chat controls and CLI-only settings', () => {
    const cli = getCompletionItems('', 'cli', 'en').map(item => item.name);
    const web = getCompletionItems('', 'web', 'en').map(item => item.name);
    for (const name of ['model', 'settings', 'effort']) assert.ok(cli.includes(name));
    assert.ok(!web.includes('settings'));
    assert.ok(!cli.includes('provider'));
});

test('local renderer settings are informational and cannot mutate provider execution', () => {
    const snapshot = { settings: {}, tuiConfig: {}, footerPreview: 'footer' };
    const rows = buildAppearanceRows(snapshot);
    const renderer = rows.find(row => row.id === 'markdownRenderer');
    assert.ok(renderer);
    assert.equal(renderer.value, 'cli-jaw Markdown');
    assert.equal(renderer.scope, 'runtime');
    assert.equal(renderer.kind, 'readonly');
    assert.equal(nextAppearancePatch(renderer, snapshot), null);
    assert.ok(rows.every(row => ['cli', 'web-ai', 'runtime'].includes(row.scope)));
});

test('TUI normalizes background updates and worker warnings without treating them as answers', () => {
    const update = { type: 'bgtask_update', id: 'task-1', status: 'running' };
    assert.deepEqual(normalizeTuiWsEvent(update), { kind: 'bgtask-update', raw: update });
    for (const type of ['worker_stalled', 'worker_timeout', 'worker_disconnected']) {
        assert.deepEqual(normalizeTuiWsEvent({ type, agentId: 'worker-1' }), {
            kind: 'worker-warning', type, agentId: 'worker-1',
        });
    }
});

test('foreign Code events remain raw records rather than TUI activity or permission requests', () => {
    for (const type of ['code_event', 'code_child_exit', 'code_permission_request', 'code_available_commands_update']) {
        const message = { type, sessionId: 'foreign-code-session', text: 'not a Jaw answer' };
        assert.deepEqual(normalizeTuiWsEvent(message), { kind: 'raw', raw: message });
    }
});
