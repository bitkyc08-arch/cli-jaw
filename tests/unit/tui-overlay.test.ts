import test from 'node:test';
import assert from 'node:assert/strict';
import {
    applyResolvedAutocompleteState,
    createAutocompleteState,
    makeSelectionKey,
    popupTotalRows,
    resolveAutocompleteState,
    syncAutocompleteWindow,
} from '../../src/cli/tui/overlay.js';

test('resolveAutocompleteState closes for non-command drafts', () => {
    const next = resolveAutocompleteState({
        draft: 'hello',
        prevKey: '',
        maxPopupRows: 10,
        maxRowsCommand: 6,
        maxRowsArgument: 8,
        getCommandItems: () => [{ name: 'help' }],
    });
    assert.equal(next.open, false);
});

test('resolveAutocompleteState opens command completion list', () => {
    const next = resolveAutocompleteState({
        draft: '/he',
        prevKey: '',
        maxPopupRows: 10,
        maxRowsCommand: 6,
        maxRowsArgument: 8,
        getCommandItems: () => [{ name: 'help', desc: 'show help' }],
    });
    assert.equal(next.open, true);
    assert.equal(next.stage, 'command');
    assert.equal(next.items.length, 1);
    assert.equal(next.visibleRows, 1);
});

test('resolveAutocompleteState opens argument completion list with context header', () => {
    const next = resolveAutocompleteState({
        draft: '/flush cod',
        prevKey: '',
        maxPopupRows: 10,
        maxRowsCommand: 6,
        maxRowsArgument: 8,
        getCommandItems: () => [],
        getArgumentItems: () => [{ name: 'codex', commandDesc: 'pick cli' }],
    });
    assert.equal(next.open, true);
    assert.equal(next.stage, 'argument');
    assert.match(next.contextHeader || '', /^flush ▸ /);
});

test('syncAutocompleteWindow clamps selection and window into visible range', () => {
    const state = createAutocompleteState();
    state.items = [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }];
    state.visibleRows = 2;
    state.selected = 3;
    state.windowStart = 0;
    syncAutocompleteWindow(state);
    assert.equal(state.windowStart, 2);
    assert.equal(state.selected, 3);
});

test('applyResolvedAutocompleteState and popupTotalRows keep overlay state coherent', () => {
    const state = createAutocompleteState();
    applyResolvedAutocompleteState(state, {
        open: true,
        stage: 'command',
        contextHeader: 'ctx',
        items: [{ name: 'help' }],
        selected: 0,
        visibleRows: 1,
    });
    assert.equal(makeSelectionKey(state.items[0], state.stage), 'command:help');
    assert.equal(popupTotalRows(state), 2);
});
