import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SIDE_PANE_PANEL_LIMIT,
    initialAppScopeState,
    scopeReducer,
    type AppScopeState,
    type OpenPanelInput,
} from '../../public/dashboard2/src/state/scope.tsx';

function open(state: AppScopeState, input: OpenPanelInput, at: number): AppScopeState {
    return scopeReducer(state, { type: 'open-panel', input, at });
}

test('panel reducer deduplicates type/key while updating payload and activation', () => {
    let state = open(initialAppScopeState, { type: 'doc', key: '/a.ts', title: 'a.ts', payload: { content: 'a' } }, 1);
    const id = state.activePanelId;
    state = open(state, { type: 'doc', key: '/a.ts', title: 'A', payload: { content: 'new' } }, 2);
    assert.equal(state.panelInstances.length, 1);
    assert.equal(state.activePanelId, id);
    assert.equal(state.panelInstances[0]?.title, 'A');
    assert.deepEqual(state.panelInstances[0]?.payload, { content: 'new' });
});

test('two documents coexist and close restores the most recently active panel', () => {
    let state = open(initialAppScopeState, { type: 'doc', key: '/a.ts', title: 'a.ts' }, 1);
    const firstId = state.activePanelId!;
    state = open(state, { type: 'doc', key: '/b.ts', title: 'b.ts' }, 2);
    const secondId = state.activePanelId!;
    state = scopeReducer(state, { type: 'activate-panel', id: firstId, at: 3 });
    state = scopeReducer(state, { type: 'activate-panel', id: secondId, at: 4 });
    state = scopeReducer(state, { type: 'close-active-panel' });
    assert.equal(state.activePanelId, firstId);
    assert.deepEqual(state.panelInstances.map((panel) => panel.key), ['/a.ts']);
});

test('pane close and picker preserve instances including protected terminal and browser', () => {
    let state = open(initialAppScopeState, { type: 'terminal', key: 'terminal', title: 'Terminal' }, 1);
    const terminal = state.panelInstances[0]!;
    state = open(state, { type: 'browser', key: 'browser', title: 'Browser' }, 2);
    state = scopeReducer(state, { type: 'show-panel-picker' });
    state = scopeReducer(state, { type: 'close-side-pane' });
    assert.equal(state.panelInstances.length, 2);
    assert.equal(state.panelInstances.find((panel) => panel.id === terminal.id)?.keepAlive, true);
    assert.equal(state.activePanelId, null);
});

test('panel limit rejects a new instance without automatic eviction', () => {
    let state = initialAppScopeState;
    for (let index = 0; index < SIDE_PANE_PANEL_LIMIT; index++) {
        state = open(state, { type: index === 0 ? 'terminal' : 'doc', key: `key-${index}`, title: `Panel ${index}` }, index + 1);
    }
    const before = state.panelInstances.map((panel) => panel.id);
    state = open(state, { type: 'doc', key: 'overflow', title: 'Overflow' }, 99);
    assert.deepEqual(state.panelInstances.map((panel) => panel.id), before);
    assert.match(state.panelOpenError ?? '', /limit reached/);
    assert.ok(state.panelInstances.some((panel) => panel.type === 'terminal'), 'terminal must never be capacity-evicted');
});
