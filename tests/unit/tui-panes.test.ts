import test from 'node:test';
import assert from 'node:assert/strict';
import {
    closePanel,
    createPaneState,
    getPanelEmptyState,
    openPanel,
    togglePanel,
} from '../../src/cli/tui/panes.js';

test('createPaneState starts closed with default side and width', () => {
    const state = createPaneState();
    assert.equal(state.openPanel, null);
    assert.equal(state.side, 'right');
    assert.equal(state.preferredWidth, 32);
});

test('openPanel and closePanel manage explicit panel visibility', () => {
    const state = createPaneState();
    openPanel(state, 'help', 'left');
    assert.equal(state.openPanel, 'help');
    assert.equal(state.side, 'left');
    closePanel(state);
    assert.equal(state.openPanel, null);
});

test('togglePanel opens and closes the same panel', () => {
    const state = createPaneState();
    togglePanel(state, 'command-palette');
    assert.equal(state.openPanel, 'command-palette');
    togglePanel(state, 'command-palette');
    assert.equal(state.openPanel, null);
});

test('each panel has an explicit empty state', () => {
    assert.equal(getPanelEmptyState('session-list'), 'No sessions yet.');
    assert.equal(getPanelEmptyState('tool-detail'), 'No tool call selected.');
});
