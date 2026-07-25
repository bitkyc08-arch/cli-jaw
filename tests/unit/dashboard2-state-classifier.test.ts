// 260726 wp12 DS-4 — fixture tests for the state-branch classifier itself.
//
// The manifest gate compares the enumerator against a snapshot the same
// enumerator produced. That catches drift but freezes misclassification: every
// wrong axis in the snapshot stays wrong and stays green. A reviewer pointed
// out that this is circular, and they were right — three separate
// classification bugs survived precisely because nothing tested the classifier
// against known-correct answers.
//
// These fixtures are the non-circular half. Each one encodes a real shape from
// dashboard2 whose correct classification is decidable by reading the code.
import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { axisOf, branchId, guardOf, hasPositiveError, isStateElement, readPrimitive, textOf } from '../../scripts/qa/enumerate-states.mts';

function parse(source: string): ts.SourceFile {
    return ts.createSourceFile('fixture.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function firstElement(source: string): { open: ts.JsxOpeningLikeElement; node: ts.Node } {
    let found: { open: ts.JsxOpeningLikeElement; node: ts.Node } | undefined;
    const visit = (n: ts.Node): void => {
        if (!found) {
            if (ts.isJsxElement(n)) found = { open: n.openingElement, node: n };
            else if (ts.isJsxSelfClosingElement(n)) found = { open: n, node: n };
        }
        n.forEachChild(visit);
    };
    visit(parse(source));
    if (!found) throw new Error('fixture contains no JSX');
    return found;
}

test('a negated error guard is not an error', () => {
    // SlashCommandMenu: `!error && commands.length === 0` renders "No matching
    // commands". Counting it as an error routed an empty list to Alert.
    assert.equal(hasPositiveError('!error && commands.length === 0'), false);
    assert.equal(axisOf('!error && commands.length === 0', 'No matching commands', 'd2-composer-menu-state'), 'empty');
});

test('an inequality against error is not an error', () => {
    // DiffPanel: `port !== null && !repoRoot && status !== 'error'`.
    assert.equal(hasPositiveError("port !== null && !repoRoot && status !== 'error'"), false);
});

test('camelCase error flags are errors', () => {
    // FileTreePanel `fileError`, TerminalPanel `workingDirectoryError`. Both
    // read as loading until the guard matcher stopped requiring a word boundary.
    assert.equal(hasPositiveError('fileError'), true);
    assert.equal(hasPositiveError('workingDirectoryError'), true);
    assert.equal(axisOf('fileError', '', 'd2-file-tree-message'), 'error');
});

test('an active loading flag outranks an empty list', () => {
    // BoardPanel `loading && tasks.length === 0` is the first load, not empty.
    assert.equal(axisOf('loading && tasks.length === 0', 'Loading board', 'd2-board-state'), 'loading');
});

test('a settled empty list is empty even when a loading flag is mentioned', () => {
    // ScheduleView `!loading && !error && items.length === 0`.
    assert.equal(axisOf('!loading && !error && items.length === 0', 'No scheduled work.', 'd2-reminders-empty'), 'empty');
});

test('visible copy outranks the guard when it names a different axis', () => {
    // SlashCommandMenu renders "Commands unavailable" under `error`. The user
    // sees an unsupported capability, not a failure banner.
    assert.equal(axisOf('error', 'Commands unavailable', 'd2-composer-menu-state'), 'unsupported');
});

test('aria-busy alone does not make an element a state surface', () => {
    // NotesFileTree marks the tree busy while its real loading branch renders
    // inside it; counting both double-counted one state.
    const tree = firstElement('<div className="d2-notes-tree" role="tree" aria-busy={loading} />');
    assert.equal(isStateElement(tree.open), false);

    // BoardPanel marks a task card busy while it saves. The card is content.
    const card = firstElement('<article className="d2-board-card" role="listitem" aria-busy={isBusy} />');
    assert.equal(isStateElement(card.open), false);
});

test('a control is never a state surface', () => {
    const button = firstElement('<button className="d2-tool-line-expand" aria-busy={busy} />');
    assert.equal(isStateElement(button.open), false);
});

test('a computed role still marks a state surface', () => {
    // SettingsToast and TerminalPanel derive role from severity; a literal-only
    // check missed both entirely.
    const toast = firstElement('<div className="d2-settings-toast" role={tone === "error" ? "alert" : "status"} />');
    assert.equal(isStateElement(toast.open), true);
});

test('a migrated primitive callsite is still a branch', () => {
    // Otherwise migration would look like deletion.
    const migrated = firstElement('<StatePanel kind="loading" title="Loading board" />');
    assert.equal(isStateElement(migrated.open), true);
});

test('a container does not absorb a nested branch text', () => {
    const source = '<div className="d2-reminders"><div className="d2-reminders-error" role="alert">Failed</div></div>';
    const outer = firstElement(source);
    assert.equal(textOf(outer.node).includes('Failed'), false);
});

test('the else side of an early return is negated', () => {
    const source = 'function P() { if (port === null) { return <div className="d2-pane-empty">a</div>; } return <div className="d2-pane-state">b</div>; }';
    const file = parse(source);
    const found: string[] = [];
    const visit = (n: ts.Node): void => {
        if (ts.isJsxElement(n)) found.push(guardOf(n));
        n.forEachChild(visit);
    };
    visit(file);
    assert.equal(found[0], 'port === null');
    assert.equal(found[1], '!(port === null)');
});

test('a branch id is derived only from things migration preserves', () => {
    const before = branchId('shell/Workbench.tsx', 'Workbench', 'status === "loading"');
    const after = branchId('shell/Workbench.tsx', 'Workbench', 'status === "loading"');
    assert.equal(before, after);
    assert.notEqual(before, branchId('shell/Workbench.tsx', 'Workbench', 'status === "error"'));
});

test('a raw branch and its migrated form parse to the same id', () => {
    // End-to-end, not just two calls with equal arguments: parse both shapes,
    // walk them the way the enumerator does, and require one identity. If this
    // ever fails, "migrated" starts looking like "deleted plus added" again.
    const shapes = [
        'function Pane() { return <>{status === "loading" ? <div className="d2-pane-empty">Loading…</div> : null}</>; }',
        'function Pane() { return <>{status === "loading" ? <StatePanel kind="loading" title="Loading…" /> : null}</>; }',
    ];

    const ids = shapes.map(source => {
        const file = parse(source);
        let id = '';
        const visit = (n: ts.Node): void => {
            const open = ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : undefined;
            if (open && isStateElement(open) && !id) id = branchId('shell/Pane.tsx', 'Pane', guardOf(n));
            n.forEachChild(visit);
        };
        visit(file);
        return id;
    });

    assert.ok(ids[0], 'the raw branch must be enumerated');
    assert.equal(ids[0], ids[1]);
});

test('a primitive callsite declares its own target and kind', () => {
    // Re-inferring target from class names marked a correct <InlineState> as a
    // StatePanel reroute, so every primitive must be read literally.
    for (const tag of ['StatePanel', 'InlineState', 'Alert', 'FieldError', 'Skeleton']) {
        const { open } = firstElement(`<${tag} kind="empty" />`);
        assert.deepEqual(readPrimitive(open), { target: tag, kind: 'empty' });
    }
    assert.equal(readPrimitive(firstElement('<div className="d2-pane-empty" />').open), null);
});

test('a primitive with no kind reports null rather than guessing', () => {
    assert.deepEqual(readPrimitive(firstElement('<Alert>Boom</Alert>').open), { target: 'Alert', kind: null });
});

test('ordinary content that merely contains a state word is not a branch', () => {
    // `d2-explore-aggregate` ends in "gate"; substring matching put a file-count
    // segment in the manifest as a loading placeholder.
    const aggregate = firstElement('<div className="d2-turn-segment d2-explore-aggregate" />');
    assert.equal(isStateElement(aggregate.open), false);
});

test('camelCase loading flags are loading, not empty', () => {
    // Sidebar `instancesLoading && instances.length === 0`.
    assert.equal(axisOf('instancesLoading && instances.length === 0', 'Loading instances', 'd2-inline-state'), 'loading');
});

test('explicit loading copy outranks a nullable guard', () => {
    // SidePane's Suspense fallbacks sit under `codePort === null` checks.
    assert.equal(axisOf('codePort === null', 'Loading Code...', 'd2-side-pane-placeholder'), 'loading');
    assert.equal(axisOf('content === null && !status', '로딩 중...', 'dock-loading'), 'loading');
});
