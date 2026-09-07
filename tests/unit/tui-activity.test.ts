import test from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeEvent } from '../../src/shared/runtime-contract.js';
import { createActivityItem, updateActivityItem, toggleActivityItem, renderActivityItem } from '../../src/cli/tui/activity.js';
import { activityTerminalWidth } from '../../src/cli/tui/activity-terminal-text.js';

const base = { version: 1 as const, runId: 'run', sessionId: 'chat', scope: 'local:chat', turnId: 'turn' };
const start: RuntimeEvent = { ...base, seq: 1, kind: 'turn-start', provider: 'codex-app' };

test('explicit disclosure survives tool updates and terminal; sparse duplicates are inert', () => {
    const item = createActivityItem(start);
    updateActivityItem(item, start);
    assert.equal(item.collapsed, true);
    toggleActivityItem(item);
    const tool: RuntimeEvent = { ...base, seq: 7, kind: 'tool', itemId: 'read', name: 'Read',
        status: 'running', input: '파일.ts', output: 'live output' };
    assert.equal(updateActivityItem(item, tool), true);
    const revision = item.revision;
    assert.equal(updateActivityItem(item, tool), false);
    assert.equal(item.revision, revision);
    assert.match(renderActivityItem(item, 80).join('\n'), /live output/);
    updateActivityItem(item, { ...base, seq: 19, kind: 'turn-end', status: 'done', finalText: 'ANSWER_OWNED_ELSEWHERE' });
    assert.equal(item.collapsed, false);
    const output = renderActivityItem(item, 80).join('\n');
    assert.match(output, /Complete/);
    assert.doesNotMatch(output, /ANSWER_OWNED_ELSEWHERE/);
    assert.equal(item.terminalStatus, 'done');
});

test('commentary stays inside Activity and authoritative empty is never inferred', () => {
    const item = createActivityItem(start, true);
    updateActivityItem(item, { ...base, seq: 3, kind: 'message', itemId: 'm', phase: 'unknown',
        operation: 'append', text: 'Intermediate work' });
    updateActivityItem(item, { ...base, seq: 9, kind: 'turn-end', status: 'stopped', finalText: null });
    const output = renderActivityItem(item, 40).join('\n');
    assert.match(output, /Stopped/);
    assert.match(output, /Intermediate work/);
    assert.doesNotMatch(output, /Final answer|Partial answer/);
});

test('waiting request is visible when collapsed and render text cannot execute terminal controls', () => {
    const item = createActivityItem(start);
    updateActivityItem(item, { ...base, seq: 4, kind: 'request', requestId: 'approve', requestType: 'approval',
        view: { title: '\x1b]52;c;secret\x07Allow file read?', fields: [] } });
    assert.match(renderActivityItem(item, 80).join('\n'), /Waiting for approval/);
    updateActivityItem(item, { ...base, seq: 8, kind: 'tool', itemId: 't', name: '\x1b[2JRead',
        status: 'running', output: '한글 👩‍💻 é\n'.repeat(40) + '\x1b]52;c;secret' });
    toggleActivityItem(item);
    for (const width of [1, 2, 20, 40, 80, 120]) {
        const lines = renderActivityItem(item, width);
        assert.ok(lines.every(line => activityTerminalWidth(line) <= width), String(width));
        assert.doesNotMatch(lines.join('\n'), /[\x1b\x07]|secret/);
    }
    updateActivityItem(item, { ...base, seq: 12, kind: 'request-settled', requestId: 'approve' });
    assert.doesNotMatch(renderActivityItem(item, 80).join('\n'), /Waiting for approval/);
});

test('foreign session, scope and turn cannot change an Activity item', () => {
    const item = createActivityItem(start);
    updateActivityItem(item, start);
    for (const key of ['sessionId', 'scope', 'turnId', 'runId'] as const) {
        assert.equal(updateActivityItem(item, { ...start, seq: 5, [key]: 'foreign' }), false);
    }
    assert.equal(item.model.seq, 1);
});
