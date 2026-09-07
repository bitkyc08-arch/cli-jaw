import '../setup/isolated-home.ts';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';
import { orchestrate } from '../../src/orchestrator/pipeline.ts';
import { addBroadcastListener, removeBroadcastListener, broadcast } from '../../src/core/bus.ts';

let dispatch: ((event: Record<string, unknown>) => void) | undefined;
mock.module('../../public/js/event-channel.js', { namedExports: {
    connectEventChannel() {},
    subscribe(topic: string, _event: unknown, callback: typeof dispatch) { if (topic === '*') dispatch = callback; return () => {}; },
    onChannelOpen() {}, onChannelDisconnect() {}, onChannelUnavailable() {},
} });
let ui: typeof import('../../public/js/ui.ts');
let state: typeof import('../../public/js/state.ts')['state'];
test.before(async () => {
    setupWebUiDom();
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ok:true,data:{count:0}}), {headers:{'Content-Type':'application/json'}}));
    ui = await import('../../public/js/ui.ts');
    ({state} = await import('../../public/js/state.ts'));
    const ws = await import('../../public/js/ws.ts');
    ws.connect();
    assert.ok(dispatch);
});
test.after(() => { ui.cleanupToolActivity(); resetWebUiDom(); mock.restoreAll(); });
test.beforeEach(() => {
    ui.cleanupToolActivity();
    document.getElementById('chatMessages')!.replaceChildren();
});

let run = 0;
function stream(): string {
    const traceRunId = `native-finality-${++run}`;
    dispatch!({event:'agent_status',running:true});
    dispatch!({event:'agent_output',text:'provisional draft',traceRunId,textLen:17});
    return traceRunId;
}

for (const runtimeFinality of ['present', 'absent']) {
    for (const text of ['', null]) {
        test(`web ${runtimeFinality} ${text === null ? 'null' : 'empty'} never finalizes the stream preview`, () => {
            const traceRunId = stream();
            dispatch!({event:'agent_done',traceRunId,text,runtimeFinality});
            const content = document.querySelector('.msg-agent .msg-content')!;
            assert.equal(content.textContent, '');
            assert.equal(content.getAttribute('data-raw'), '');
            assert.equal(state.agentBusy, false);
            assert.equal(state.currentAgentDiv, null);
            assert.equal(document.querySelectorAll('.stream-cursor').length, 0);
        });
    }
}

for (const first of ['agent_done', 'orchestrate_done']) {
    test(`web correlated fixture: native ${first} and other terminal render once beyond time guard`, t => {
        const traceRunId = stream();
        const terminal = {traceRunId,text:'exact final',runtimeFinality:'present'};
        dispatch!({event:first,...terminal});
        const original = document.querySelector('.msg-agent');
        const now = Date.now();
        t.mock.method(Date, 'now', () => now + 1000);
        dispatch!({event:first === 'agent_done' ? 'orchestrate_done' : 'agent_done',...terminal});
        assert.equal(document.querySelectorAll('.msg-agent').length, 1);
        assert.equal(document.querySelector('.msg-agent'), original);
        assert.equal(document.querySelector('.msg-content')?.textContent?.trim(), 'exact final');
        assert.equal(document.querySelector('.msg-content')?.getAttribute('data-raw'), 'exact final');
    });
}

// Lifecycle tests own agent_done/result identity equality. Here only spawn is
// injected: the real pipeline must propagate that result's provenance onto its
// actual broadcast, which the real UI consumes after its timing guard expires.
test('web real pipeline terminal preserves spawn provenance and dedupes delayed agent_done pair', async t => {
    const traceRunId = stream();
    const terminal = {
        text: 'exact native answer', runtimeFinality: 'present', runtimeStatus: 'done',
        requestId: 'native-request-fixture', origin: 'web', scope: 'native-ui-pipeline', sessionId: 'default',
    };
    const captured: Array<{type: string; data: Record<string, unknown>}> = [];
    const listener = (type: string, data: Record<string, unknown>) => {
        if (data['requestId'] !== terminal.requestId || (type !== 'agent_done' && type !== 'orchestrate_done')) return;
        // Match the JSON wire without supplementing the producer's payload.
        const wire = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
        captured.push({type, data: wire});
        if (type === 'agent_done') dispatch!({...wire, event: type});
    };
    let spawnCalls = 0;
    addBroadcastListener(listener);
    try {
        await orchestrate('Check the native UI terminal fixture', {
            origin: terminal.origin, requestId: terminal.requestId,
            scope: terminal.scope, chatSessionId: terminal.sessionId,
            _skipInsert: true, _skipReplayDrain: true, _skipClear: true,
            _spawnAgent: () => {
                spawnCalls++;
                broadcast('agent_done', {traceRunId, ...terminal});
                return {child: null, promise: Promise.resolve({
                    text: terminal.text, code: 0, traceRunId,
                    runtimeOutcome: {status: 'done', finalText: terminal.text, partialText: 'PRIVATE_PROVISIONAL'},
                })};
            },
        });
        assert.equal(spawnCalls, 1);
        assert.deepEqual(captured.map(entry => entry.type), ['agent_done', 'orchestrate_done']);
        const pipelineTerminal = captured[1]!.data;
        assert.equal(pipelineTerminal['traceRunId'], traceRunId);
        assert.equal(pipelineTerminal['runtimeFinality'], 'present');
        assert.equal(pipelineTerminal['runtimeStatus'], 'done');
        assert.equal(pipelineTerminal['requestId'], terminal.requestId);
        assert.doesNotMatch(JSON.stringify(pipelineTerminal), /PRIVATE_PROVISIONAL|runtimeOutcome|partialText/);
        const original = document.querySelector('.msg-agent');
        assert.equal(document.querySelectorAll('.msg-agent').length, 1);
        assert.equal(state.currentAgentDiv, null);

        const now = Date.now();
        t.mock.method(Date, 'now', () => now + 1000);
        dispatch!({...pipelineTerminal, event: 'orchestrate_done'});

        assert.equal(document.querySelectorAll('.msg-agent').length, 1);
        assert.equal(document.querySelector('.msg-agent'), original);
        assert.equal(document.querySelector('.msg-content')?.getAttribute('data-raw'), terminal.text);
        assert.equal(state.agentBusy, false);
    } finally {
        removeBroadcastListener(listener);
    }
});

test('untagged and invalid web finality preserve tool-backed legacy stream fallback', () => {
    for (const runtimeFinality of [undefined, 'bad', null]) {
        ui.cleanupToolActivity();
        document.getElementById('chatMessages')!.replaceChildren();
        const traceRunId = stream();
        dispatch!({event:'agent_done',traceRunId,text:'',runtimeFinality,toolLog:[{icon:'tool',label:'read',detail:'done'}]});
        assert.equal(document.querySelector('.msg-content')?.textContent?.trim(), 'provisional draft');
        assert.equal(document.querySelector('.msg-content')?.getAttribute('data-raw'), 'provisional draft');
        assert.equal(state.agentBusy, false);
    }
});

test('direct web finalizer accepts native null and cancels the provisional renderer', () => {
    ui.appendAgentText('pending provisional');
    ui.finalizeAgent(null, undefined, 'absent');
    assert.equal(document.querySelector('.msg-content')?.textContent, '');
    assert.equal(document.querySelector('.msg-content')?.getAttribute('data-raw'), '');
    assert.equal(state.agentBusy, false);
});

test('RID-005: stale and replayed completion cannot finalize the current run', t => {
    const a = stream();
    const aHost = state.currentAgentDiv;
    dispatch!({ event: 'agent_done', traceRunId: 'foreign-run', text: 'FOREIGN', runtimeFinality: 'present' });
    assert.equal(state.currentAgentDiv, aHost); assert.equal(state.agentBusy, true);
    dispatch!({ event: 'agent_done', traceRunId: a, text: 'A final', runtimeFinality: 'present' });
    const now = Date.now(); t.mock.method(Date, 'now', () => now + 1000);
    dispatch!({ event: 'agent_done', traceRunId: a, text: 'duplicate A', runtimeFinality: 'present', sseReplay: true });
    assert.equal(document.querySelectorAll('.msg-agent').length, 1);
    assert.equal(aHost?.querySelector('.msg-content')?.getAttribute('data-raw'), 'A final');
    const b = stream(); const bHost = state.currentAgentDiv;
    dispatch!({ event: 'orchestrate_done', traceRunId: a, text: 'late A', runtimeFinality: 'present', sseReplay: true });
    assert.equal(state.currentAgentDiv, bHost); assert.equal(state.agentBusy, true);
    dispatch!({ event: 'agent_done', traceRunId: b, text: 'B final', runtimeFinality: 'present' });
    assert.equal(document.querySelectorAll('.msg-agent').length, 2);
    assert.equal(bHost?.querySelector('.msg-content')?.getAttribute('data-raw'), 'B final');
    assert.equal(aHost?.querySelector('.msg-content')?.getAttribute('data-raw'), 'A final');
});
