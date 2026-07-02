import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createTranscriptState, appendToolItem, appendStatusItem, clearEphemeralStatus,
    toggleToolExpansion, upsertLiveToolItem, commitToolItemOnce, clearLiveToolItems,
} from '../../src/cli/tui/transcript.ts';

test('appendToolItem adds a persistent tool item', () => {
    const s = createTranscriptState();
    appendToolItem(s, '🔧 Edit src/x.ts');
    assert.equal(s.items.length, 1);
    assert.equal(s.items[0]!.type, 'tool');
    assert.equal((s.items[0] as { text: string }).text, '🔧 Edit src/x.ts');
});

test('tool items accumulate and are never replaced (unlike status)', () => {
    const s = createTranscriptState();
    appendToolItem(s, 'a');
    appendToolItem(s, 'b');
    appendToolItem(s, 'c');
    assert.equal(s.items.length, 3);
    assert.deepEqual(s.items.map(i => (i as { text: string }).text), ['a', 'b', 'c']);
});

test('tool item with same stepRef updates in place instead of duplicating', () => {
    const s = createTranscriptState();
    appendToolItem(s, '🔧 Bash echo 1', { stepRef: 'tool-1', status: 'running', detail: 'echo 1' });
    appendToolItem(s, '🔧 Bash', { stepRef: 'tool-1', status: 'done' });

    assert.equal(s.items.length, 1);
    assert.equal(s.items[0]!.type, 'tool');
    if (s.items[0]!.type === 'tool') {
        assert.equal(s.items[0]!.text, '🔧 Bash echo 1');
        assert.equal(s.items[0]!.stepRef, 'tool-1');
        assert.equal(s.items[0]!.status, 'done');
        assert.equal(s.items[0]!.collapsed, true);
        assert.equal(s.items[0]!.detail, 'echo 1');
    }
});

test('clearEphemeralStatus does NOT remove a trailing tool item', () => {
    const s = createTranscriptState();
    appendToolItem(s, 'tool line');
    clearEphemeralStatus(s);
    assert.equal(s.items.length, 1);
    assert.equal(s.items[0]!.type, 'tool');
});

test('ws-handler order: clearEphemeralStatus before appendToolItem drops the transient status', () => {
    const s = createTranscriptState();
    appendStatusItem(s, 'agent working...'); // transient running spinner
    assert.equal(s.items.length, 1);
    // simulate the agent_tool handler sequence
    clearEphemeralStatus(s);
    appendToolItem(s, '🔧 Bash npm test');
    assert.equal(s.items.length, 1, 'transient status must not leak alongside the tool cell');
    assert.equal(s.items[0]!.type, 'tool');
});

test('status still replaces only the trailing status after tool items', () => {
    const s = createTranscriptState();
    appendToolItem(s, 'tool');
    appendStatusItem(s, 'status 1');
    appendStatusItem(s, 'status 2'); // replaces status 1
    assert.equal(s.items.length, 2);
    assert.equal(s.items[0]!.type, 'tool');
    assert.equal(s.items[1]!.type, 'status');
    assert.equal((s.items[1] as { text: string }).text, 'status 2');
});

test('toggleToolExpansion toggles all tool rows as a full sweep', () => {
    const s = createTranscriptState();
    assert.equal(toggleToolExpansion(s), false);

    appendToolItem(s, '🔧 Bash first', { stepRef: 'first', status: 'done', detail: 'first detail' });
    appendStatusItem(s, 'transient status');
    appendToolItem(s, '🔧 Bash second', { stepRef: 'second', status: 'done', detail: 'second detail' });

    assert.equal(toggleToolExpansion(s), true);

    const first = s.items[0]!;
    const status = s.items[1]!;
    const second = s.items[2]!;
    assert.equal(first.type, 'tool');
    assert.equal(status.type, 'status');
    assert.equal(second.type, 'tool');
    if (first.type === 'tool' && second.type === 'tool') {
        assert.equal(first.collapsed, false);
        assert.equal(second.collapsed, false);
    }

    assert.equal(toggleToolExpansion(s), true);
    if (first.type === 'tool' && second.type === 'tool') {
        assert.equal(first.collapsed, true);
        assert.equal(second.collapsed, true);
    }
});

test('live tool state updates running tools without appending transcript rows', () => {
    const s = createTranscriptState();
    upsertLiveToolItem(s, { icon: '🔧', label: 'Bash', detail: 'echo 1', status: 'running', stepRef: 's1' });
    upsertLiveToolItem(s, { icon: '🔧', label: 'Bash', detail: 'echo 2', status: 'running', stepRef: 's1' });

    assert.equal(s.items.length, 0);
    assert.equal(s.liveTools.length, 1);
    assert.equal(s.liveTools[0]?.detail, 'echo 2');
});

test('terminal tool commit removes live state and appends one folded row', () => {
    const s = createTranscriptState();
    upsertLiveToolItem(s, { icon: '🔧', label: 'Bash', detail: 'echo kept', status: 'running', stepRef: 's1' });

    assert.equal(commitToolItemOnce(s, { icon: '🔧', label: 'Bash', detail: '', status: 'done', stepRef: 's1' }), true);
    assert.equal(commitToolItemOnce(s, { icon: '🔧', label: 'Bash', detail: 'duplicate', status: 'done', stepRef: 's1' }), false);

    assert.equal(s.liveTools.length, 0);
    assert.equal(s.items.length, 1);
    const item = s.items[0]!;
    assert.equal(item.type, 'tool');
    if (item.type === 'tool') {
        assert.equal(item.text, 'Bash');
        assert.equal(item.collapsed, true);
        assert.equal(item.detail, 'echo kept');
        assert.equal(item.stepRef, 's1');
        assert.equal(item.status, 'done');
    }
});

test('terminal tool commit stores label without duplicated event emoji', () => {
    const s = createTranscriptState();

    assert.equal(commitToolItemOnce(s, { icon: '🔧', label: 'Read File', detail: 'src/a.ts', status: 'done', stepRef: 's-read' }), true);

    const item = s.items[0]!;
    assert.equal(item.type, 'tool');
    if (item.type === 'tool') {
        assert.equal(item.text, 'Read File');
        assert.doesNotMatch(item.text, /🔧/);
        assert.equal(item.detail, 'src/a.ts');
    }
});

test('clearLiveToolItems clears only live state', () => {
    const s = createTranscriptState();
    appendToolItem(s, '🔧 Bash done', { status: 'done', detail: 'done' });
    upsertLiveToolItem(s, { icon: '🔧', label: 'Read', detail: 'file', status: 'running' });

    const cleared = clearLiveToolItems(s);
    assert.equal(cleared.length, 1);
    assert.equal(s.liveTools.length, 0);
    assert.equal(s.items.length, 1);
});

test('toggleToolExpansion(fromIndex) leaves committed items untouched', async () => {
    const { createTranscriptState, appendToolItem, toggleToolExpansion } = await import('../../src/cli/tui/transcript.ts');
    const state = createTranscriptState();
    appendToolItem(state, 'committed tool', { status: 'done', stepRef: 'c-1' });
    appendToolItem(state, 'live tool', { status: 'done', stepRef: 'l-1' });

    assert.equal(toggleToolExpansion(state, 1), true);
    const committed = state.items[0]!;
    const live = state.items[1]!;
    if (committed.type === 'tool' && live.type === 'tool') {
        assert.equal(committed.collapsed, true, 'committed item must keep its frozen collapsed state');
        assert.equal(live.collapsed, false, 'uncommitted item expands');
    }

    assert.equal(toggleToolExpansion(state, state.items.length), false, 'nothing to toggle past the frontier without live tools');
});
