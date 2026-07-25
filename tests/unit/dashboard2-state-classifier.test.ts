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
import { axisOf, branchId, guardOf, hasPositiveError, isStateElement, textOf } from '../../scripts/qa/enumerate-states.mts';

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

test('a branch id survives migration', () => {
    // The whole point: the id is derived from the guard, which migration keeps.
    // If the id changed, "migrated" would be indistinguishable from "deleted".
    const before = branchId('shell/Workbench.tsx', 'Workbench', 'status === "loading"');
    const after = branchId('shell/Workbench.tsx', 'Workbench', 'status === "loading"');
    assert.equal(before, after);
    assert.notEqual(before, branchId('shell/Workbench.tsx', 'Workbench', 'status === "error"'));
});
