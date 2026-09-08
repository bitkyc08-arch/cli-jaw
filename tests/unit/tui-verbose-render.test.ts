/**
 * Verbose render mode is a session-scoped override: tool/thinking blocks
 * settle expanded, with no
 * minimize-on-next-tool, fold toggles are commit-mode-only.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    createTranscriptState,
    setVerboseRenderMode,
    isVerboseRenderMode,
    appendToolItem,
    appendThinkingItem,
    commitThinkingItemOnce,
    upsertLiveToolItem,
    commitToolItemOnce,
    commitRemainingLiveToolItems,
    clearLiveToolItems,
    collapsePreviousTools,
    toggleToolExpansion,
    toggleLatestToolExpansion,
} from '../../src/cli/tui/transcript.ts';

afterEach(() => {
    setVerboseRenderMode(false);
});

test('default mode: done tool settles collapsed and toggles work', () => {
    const s = createTranscriptState();
    appendToolItem(s, 'Read file', { status: 'done', detail: 'src/a.ts' });
    const tool = s.items.find(i => i.type === 'tool');
    assert.ok(tool && tool.type === 'tool');
    assert.equal(tool.collapsed, true);
    assert.equal(toggleToolExpansion(s), true);
    assert.equal(tool.collapsed, false);
});

test('verbose: new done tool stays expanded', () => {
    setVerboseRenderMode(true);
    assert.equal(isVerboseRenderMode(), true);
    const s = createTranscriptState();
    appendToolItem(s, 'Read file', { status: 'done', detail: 'src/a.ts' });
    const tool = s.items.find(i => i.type === 'tool');
    assert.ok(tool && tool.type === 'tool');
    assert.equal(tool.collapsed, false);
});

test('verbose: running→done stepRef update stays expanded', () => {
    setVerboseRenderMode(true);
    const s = createTranscriptState();
    appendToolItem(s, 'Bash', { stepRef: 'r1', status: 'running' });
    appendToolItem(s, 'Bash', { stepRef: 'r1', status: 'done', detail: 'ls -la' });
    const tool = s.items.find(i => i.type === 'tool' && i.stepRef === 'r1');
    assert.ok(tool && tool.type === 'tool');
    assert.equal(tool.status, 'done');
    assert.equal(tool.collapsed, false);
});

test('verbose: collapsePreviousTools is a no-op (no minimize at next tool)', () => {
    setVerboseRenderMode(true);
    const s = createTranscriptState();
    appendToolItem(s, 'ToolA', {});
    collapsePreviousTools(s);
    appendToolItem(s, 'ToolB', {});
    const tools = s.items.filter(i => i.type === 'tool');
    assert.equal(tools.length, 2);
    for (const t of tools) assert.equal(t.type === 'tool' && t.collapsed, false);
});

test('verbose: committed thinking settles expanded', () => {
    setVerboseRenderMode(true);
    const s = createTranscriptState();
    commitThinkingItemOnce(s, { icon: '?', label: 'Thinking', detail: 'pondering', stepRef: 't1', status: 'done' });
    const think = s.items.find(i => i.type === 'thinking');
    assert.ok(think && think.type === 'thinking');
    assert.equal(think.collapsed, false);
});

test('verbose: appendThinkingItem default settles expanded', () => {
    setVerboseRenderMode(true);
    const s = createTranscriptState();
    appendThinkingItem(s, 'deep thought');
    const think = s.items.find(i => i.type === 'thinking');
    assert.ok(think && think.type === 'thinking');
    assert.equal(think.collapsed, false);
});

test('verbose: fold toggles are commit-mode-only (return false, no mutation)', () => {
    setVerboseRenderMode(true);
    const s = createTranscriptState();
    appendToolItem(s, 'Read file', { status: 'done' });
    const tool = s.items.find(i => i.type === 'tool');
    assert.ok(tool && tool.type === 'tool');
    assert.equal(toggleToolExpansion(s), false);
    assert.equal(toggleLatestToolExpansion(s), false);
    assert.equal(tool.collapsed, false);
});

test('verbose: live-lane commit/clear leaves liveToolsExpanded on', () => {
    setVerboseRenderMode(true);
    const s = createTranscriptState();
    s.liveToolsExpanded = true;
    upsertLiveToolItem(s, { icon: '⚙', label: 'Bash', detail: 'ls', stepRef: 'l1', status: 'running' });
    commitRemainingLiveToolItems(s);
    assert.equal(s.liveToolsExpanded, true);
    const committed = s.items.find(i => i.type === 'tool' && i.stepRef === 'l1');
    assert.ok(committed && committed.type === 'tool');
    assert.equal(committed.collapsed, false);

    upsertLiveToolItem(s, { icon: '⚙', label: 'Grep', detail: 'foo', stepRef: 'l2', status: 'running' });
    clearLiveToolItems(s);
    assert.equal(s.liveToolsExpanded, true);
});

test('default mode after reset: commitToolItemOnce settles collapsed', () => {
    const s = createTranscriptState();
    upsertLiveToolItem(s, { icon: '⚙', label: 'Bash', detail: 'ls', stepRef: 'd1', status: 'running' });
    commitToolItemOnce(s, { icon: '⚙', label: 'Bash', detail: 'ls', stepRef: 'd1', status: 'done' });
    const tool = s.items.find(i => i.type === 'tool' && i.stepRef === 'd1');
    assert.ok(tool && tool.type === 'tool');
    assert.equal(tool.collapsed, true);
    assert.equal(s.liveToolsExpanded, false);
});
