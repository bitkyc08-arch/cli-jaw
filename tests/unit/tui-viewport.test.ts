import test from 'node:test';
import assert from 'node:assert/strict';
import { Viewport } from '../../src/cli/tui/render/viewport.ts';
import type { TranscriptItem } from '../../src/cli/tui/transcript.ts';

const render = (item: TranscriptItem) => [item.type === 'user' ? `u:${(item as { displayText: string }).displayText}` : item.type];

test('Viewport followTail keeps scroll at bottom', () => {
    const v = new Viewport();
    v.setItems([
        { type: 'user', displayText: 'a', submitText: 'a', timestamp: 0 },
        { type: 'user', displayText: 'b', submitText: 'b', timestamp: 1 },
    ], render);
    v.scrollBy(-5, 1);
    assert.notEqual(v.composeRegion({ x: 1, y: 1, width: 40, height: 1 })[0], 'u:b');
    v.followTail(true, 1);
    assert.equal(v.composeRegion({ x: 1, y: 1, width: 40, height: 1 })[0], 'u:b');
});

test('Viewport tail-follow bottom-aligns short transcript', () => {
    const v = new Viewport();
    v.setItems([
        { type: 'user', displayText: 'hello', submitText: 'hello', timestamp: 0 },
    ], render, 4);

    assert.deepEqual(
        v.composeRegion({ x: 1, y: 1, width: 40, height: 4 }),
        ['u:hello'],
    );
});

test('Viewport top-aligns uncommitted welcome prelude before transcript collides', () => {
    const v = new Viewport();
    v.setPrelude(['welcome']);
    v.setItems([
        { type: 'user', displayText: '1', submitText: '1', timestamp: 0 },
    ], render, 4);

    assert.deepEqual(
        v.composeRegion({ x: 1, y: 1, width: 40, height: 4 }),
        ['welcome', 'u:1', '', ''],
    );
});

test('Viewport keeps launch welcome anchored at top while no transcript items exist', () => {
    const v = new Viewport();
    v.setPrelude(['welcome-1', 'welcome-2', 'welcome-3', 'welcome-4']);
    v.setItems([], render, 2);

    assert.deepEqual(
        v.composeRegion({ x: 1, y: 1, width: 40, height: 2 }),
        ['welcome-1', 'welcome-2'],
    );

    v.setItems([], render, 4);
    assert.deepEqual(
        v.composeRegion({ x: 1, y: 1, width: 40, height: 4 }),
        ['welcome-1', 'welcome-2', 'welcome-3', 'welcome-4'],
    );
});

test('Viewport commits welcome prelude with older transcript rows after collision', () => {
    const v = new Viewport();
    v.setPrelude(['welcome']);
    v.setItems([
        { type: 'user', displayText: '1', submitText: '1', timestamp: 0 },
        { type: 'user', displayText: '2', submitText: '2', timestamp: 1 },
        { type: 'user', displayText: '3', submitText: '3', timestamp: 2 },
        { type: 'user', displayText: '4', submitText: '4', timestamp: 3 },
    ], render, 3);

    const firstCommit = v.peekStableCommitRows(3, 4);
    assert.ok(firstCommit !== null);
    assert.deepEqual(firstCommit.rows, ['welcome', 'u:1']);

    v.markCommittedFrontier(firstCommit.frontier);
    assert.deepEqual(
        v.composeRegion({ x: 1, y: 1, width: 40, height: 3 }),
        ['u:2', 'u:3', 'u:4'],
    );
});

test('Viewport rerenders same-length user content changes', () => {
    const v = new Viewport();
    v.setItems([{ type: 'user', displayText: 'abc', submitText: 'abc', timestamp: 0 }], render);
    assert.equal(v.composeRegion({ x: 1, y: 1, width: 40, height: 1 })[0], 'u:abc');

    v.setItems([{ type: 'user', displayText: 'xyz', submitText: 'xyz', timestamp: 1 }], render);
    assert.equal(v.composeRegion({ x: 1, y: 1, width: 40, height: 1 })[0], 'u:xyz');
});

test('Viewport rerenders same-length assistant content changes', () => {
    const v = new Viewport();
    const renderAssistant = (item: TranscriptItem) => [item.type === 'assistant' ? `a:${item.text}` : item.type];
    v.setItems([{ type: 'assistant', text: 'foo', streaming: true, timestamp: 0 }], renderAssistant);
    assert.equal(v.composeRegion({ x: 1, y: 1, width: 40, height: 1 })[0], 'a:foo');

    v.setItems([{ type: 'assistant', text: 'bar', streaming: true, timestamp: 1 }], renderAssistant);
    assert.equal(v.composeRegion({ x: 1, y: 1, width: 40, height: 1 })[0], 'a:bar');
});

test('Viewport rerenders same-length tool content changes', () => {
    const v = new Viewport();
    const renderTool = (item: TranscriptItem) => [item.type === 'tool' ? `t:${item.text}` : item.type];
    v.setItems([{ type: 'tool', text: 'Read a', collapsed: false, timestamp: 0 }], renderTool);
    assert.equal(v.composeRegion({ x: 1, y: 1, width: 40, height: 1 })[0], 't:Read a');

    v.setItems([{ type: 'tool', text: 'Edit b', collapsed: false, timestamp: 1 }], renderTool);
    assert.equal(v.composeRegion({ x: 1, y: 1, width: 40, height: 1 })[0], 't:Edit b');
});

test('Viewport rerenders tool detail-only changes', () => {
    const v = new Viewport();
    const renderTool = (item: TranscriptItem) => [item.type === 'tool' ? `d:${item.detail ?? ''}` : item.type];
    v.setItems([{ type: 'tool', text: 'Bash', detail: 'aaa', collapsed: false, timestamp: 0 }], renderTool);
    assert.equal(v.composeRegion({ x: 1, y: 1, width: 40, height: 1 })[0], 'd:aaa');

    v.setItems([{ type: 'tool', text: 'Bash', detail: 'bbb', collapsed: false, timestamp: 1 }], renderTool);
    assert.equal(v.composeRegion({ x: 1, y: 1, width: 40, height: 1 })[0], 'd:bbb');
});

test('Viewport rerenders tool status and stepRef changes', () => {
    const v = new Viewport();
    const renderTool = (item: TranscriptItem) => [item.type === 'tool' ? `s:${item.status ?? ''}:${item.stepRef ?? ''}` : item.type];
    v.setItems([{ type: 'tool', text: 'Bash', detail: 'same', collapsed: true, status: 'done', stepRef: 's1', timestamp: 0 }], renderTool);
    assert.equal(v.composeRegion({ x: 1, y: 1, width: 40, height: 1 })[0], 's:done:s1');

    v.setItems([{ type: 'tool', text: 'Bash', detail: 'same', collapsed: true, status: 'error', stepRef: 's2', timestamp: 1 }], renderTool);
    assert.equal(v.composeRegion({ x: 1, y: 1, width: 40, height: 1 })[0], 's:error:s2');
});

test('Viewport width changes rerender cells', () => {
    const v = new Viewport();
    const renderWithWidth = (item: TranscriptItem, width: number) => [`${item.type}:${width}`];
    v.setItems([{ type: 'user', displayText: 'same', submitText: 'same', timestamp: 0 }], renderWithWidth);
    assert.equal(v.composeRegion({ x: 1, y: 1, width: 40, height: 1 })[0], 'user:80');

    v.setWidth(42);
    v.setItems([{ type: 'user', displayText: 'same', submitText: 'same', timestamp: 0 }], renderWithWidth);
    assert.equal(v.composeRegion({ x: 1, y: 1, width: 40, height: 1 })[0], 'user:42');
});

test('Viewport scrollback can reach current jaw chat launch session start', () => {
    const v = new Viewport();
    v.setPrelude(['welcome']);
    v.setItems([
        { type: 'user', displayText: 'session start', submitText: 'session start', timestamp: 0 },
        { type: 'assistant', text: 'old answer', streaming: false, timestamp: 1 },
        { type: 'user', displayText: 'current prompt', submitText: 'current prompt', timestamp: 2 },
        { type: 'assistant', text: 'current answer', streaming: false, timestamp: 3 },
    ], render, 2);

    assert.deepEqual(
        v.composeRegion({ x: 1, y: 1, width: 40, height: 2 }),
        ['u:current prompt', 'assistant'],
    );

    v.scrollToTop();
    assert.deepEqual(
        v.composeRegion({ x: 1, y: 1, width: 40, height: 3 }),
        ['welcome', 'u:session start', 'assistant'],
    );
});

test('Viewport exposes offscreen launch transcript rows for native scrollback commit', () => {
    const v = new Viewport();
    v.setItems([
        { type: 'user', displayText: '1', submitText: '1', timestamp: 0 },
        { type: 'user', displayText: '2', submitText: '2', timestamp: 1 },
        { type: 'user', displayText: '3', submitText: '3', timestamp: 2 },
        { type: 'user', displayText: '4', submitText: '4', timestamp: 3 },
        { type: 'user', displayText: '5', submitText: '5', timestamp: 4 },
    ], render, 3);

    const firstCommit = v.peekStableCommitRows(3, 5);
    assert.ok(firstCommit !== null);
    assert.deepEqual(firstCommit.rows, ['u:1', 'u:2']);

    v.markCommittedFrontier(firstCommit.frontier);
    assert.deepEqual(
        v.composeRegion({ x: 1, y: 1, width: 40, height: 3 }),
        ['u:3', 'u:4', 'u:5'],
    );

    v.setItems([
        { type: 'user', displayText: '1', submitText: '1', timestamp: 0 },
        { type: 'user', displayText: '2', submitText: '2', timestamp: 1 },
        { type: 'user', displayText: '3', submitText: '3', timestamp: 2 },
        { type: 'user', displayText: '4', submitText: '4', timestamp: 3 },
        { type: 'user', displayText: '5', submitText: '5', timestamp: 4 },
        { type: 'user', displayText: '6', submitText: '6', timestamp: 5 },
    ], render, 3);

    assert.deepEqual(v.peekStableCommitRows(3, 6)?.rows, ['u:3']);
});

test('Viewport does not commit additional rows while user is reading earlier content', () => {
    const v = new Viewport();
    v.setItems([
        { type: 'user', displayText: '1', submitText: '1', timestamp: 0 },
        { type: 'user', displayText: '2', submitText: '2', timestamp: 1 },
        { type: 'user', displayText: '3', submitText: '3', timestamp: 2 },
        { type: 'user', displayText: '4', submitText: '4', timestamp: 3 },
    ], render, 2);

    v.scrollToTop();
    assert.equal(v.peekStableCommitRows(2, 4), null);
});
