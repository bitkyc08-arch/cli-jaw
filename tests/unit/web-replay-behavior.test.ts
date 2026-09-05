import '../setup/isolated-home.ts';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';
import { addBroadcastListener, removeBroadcastListener } from '../../src/core/bus.ts';
import { settings } from '../../src/core/config.ts';
import { handleAgentExit, clearGoalTimers, type ExitHandlerParams } from '../../src/agent/lifecycle-handler.ts';
import { resetFlushCountersForTest } from '../../src/agent/memory-flush-controller.ts';

// Behavioral replacements for RID-001/RID-010. Observe the actual producer
// and dispatcher rather than requiring one spelling of run retirement.
let dispatch: ((event: Record<string, unknown>) => void) | undefined;
mock.module('../../public/js/event-channel.js', { namedExports: {
    connectEventChannel() {},
    subscribe(topic: string, _event: unknown, callback: typeof dispatch) {
        if (topic === '*') dispatch = callback;
        return () => {};
    },
    onChannelOpen() {}, onChannelDisconnect() {}, onChannelUnavailable() {},
} });
let ui: typeof import('../../public/js/ui.ts');
let state: typeof import('../../public/js/state.ts')['state'];
let serial = 0;
test.before(async () => {
    setupWebUiDom();
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ok: true, data: { count: 0 } }), {
        headers: { 'Content-Type': 'application/json' },
    }));
    settings['fallbackOrder'] = [];
    settings['memory'] = { ...settings['memory'], enabled: false };
    ui = await import('../../public/js/ui.ts');
    ({ state } = await import('../../public/js/state.ts'));
    (await import('../../public/js/ws.ts')).connect();
    assert.ok(dispatch);
});
test.beforeEach(t => {
    ui.clearSteer();
    ui.cleanupToolActivity();
    document.getElementById('chatMessages')!.replaceChildren();
    resetFlushCountersForTest();
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'warn', () => {});
});
test.afterEach(() => {
    ui.finalizeAgent('', [], 'absent');
    ui.cleanupToolActivity();
    ui.clearSteer();
    clearGoalTimers();
});
test.after(() => { ui.cleanupToolActivity(); resetWebUiDom(); mock.restoreAll(); });

function stream(text = 'live answer') {
    const traceRunId = `replay-behavior-${++serial}`;
    dispatch!({ event: 'agent_status', running: true });
    dispatch!({ event: 'agent_output', text, traceRunId, textLen: text.length });
    return traceRunId;
}
function currentBubble() {
    return document.querySelectorAll('.msg-agent').item(document.querySelectorAll('.msg-agent').length - 1);
}

for (const tagged of [false, true]) {
    test(`RID-010 ${tagged ? 'native tagged' : 'legacy untagged'} completion retires the adopted run beyond time guards`, t => {
        const first = stream();
        dispatch!({ event: 'orchestrate_done', text: 'settled answer',
            ...(tagged ? { traceRunId: first, runtimeFinality: 'present' } : {}),
        });
        const original = currentBubble();
        assert.equal(original?.querySelector('.msg-content')?.getAttribute('data-raw'), 'settled answer');
        assert.equal(state.currentAgentDiv, null);
        const later = Date.now() + 10_000;
        t.mock.method(Date, 'now', () => later);
        dispatch!({ event: 'agent_output', traceRunId: first, text: 'OLD REPLAY', textLen: 100, sseReplay: true });
        assert.equal(document.querySelectorAll('.msg-agent').length, 1, 'retired output cannot build a second bubble');
        assert.equal(currentBubble(), original);
        assert.equal(state.currentAgentDiv, null);

        const second = stream('replacement answer');
        const replacement = currentBubble();
        dispatch!({ event: 'orchestrate_done', traceRunId: first, text: 'STALE FINAL', runtimeFinality: 'present', sseReplay: true });
        assert.equal(state.currentAgentDiv, replacement, 'late old terminal cannot settle the replacement');
        assert.equal(state.agentBusy, true);
        assert.equal(document.querySelectorAll('.msg-agent').length, 2);
        dispatch!({ event: 'orchestrate_done', traceRunId: second, text: 'replacement final', runtimeFinality: 'present' });
        assert.equal(replacement?.querySelector('.msg-content')?.getAttribute('data-raw'), 'replacement final');
    });
}

test('RID-010 a terminal from an unknown foreign run cannot finalize the current stream', () => {
    const current = stream();
    const bubble = currentBubble();
    dispatch!({ event: 'orchestrate_done', traceRunId: 'foreign-' + current, text: 'FOREIGN', runtimeFinality: 'present' });
    assert.equal(state.currentAgentDiv, bubble);
    assert.equal(state.agentBusy, true);
    assert.equal(document.querySelectorAll('.msg-agent').length, 1);
    dispatch!({ event: 'orchestrate_done', traceRunId: current, text: 'own final', runtimeFinality: 'present' });
    assert.equal(bubble?.querySelector('.msg-content')?.getAttribute('data-raw'), 'own final');
});

test('RID-010 steer retires the killed run even after the recent-steer time guard expires', t => {
    const killed = stream();
    dispatch!({ event: 'steer_started' });
    const original = currentBubble();
    const count = document.querySelectorAll('.msg-agent').length;
    const later = Date.now() + 10_000;
    t.mock.method(Date, 'now', () => later);
    assert.equal(ui.isRecentSteer(), false, 'the time guard must not make this oracle pass');
    dispatch!({ event: 'agent_output', traceRunId: killed, text: 'KILLED REPLAY', textLen: 100, sseReplay: true });
    dispatch!({ event: 'agent_done', traceRunId: killed, text: 'KILLED FINAL' });
    assert.equal(document.querySelectorAll('.msg-agent').length, count);
    assert.equal(currentBubble(), original);
    assert.equal(state.currentAgentDiv, null);
});

function lifecycle(kind: string): ExitHandlerParams {
    const id = `trace-receipt-${++serial}`;
    const native = kind.startsWith('native');
    const status = kind === 'native-error' ? 'error' : kind === 'native-stopped' ? 'stopped' : 'done';
    const ctx: ExitHandlerParams['ctx'] = {
        fullText: kind === 'legacy-error' || kind === 'legacy-stall' ? '' : 'legacy answer',
        sessionId: null, toolLog: [], traceLog: [], stderrBuf: '', turns: 0, traceRunId: id,
    };
    if (native) ctx.runtimeOutcome = { status, finalText: status === 'done' ? 'native answer' : null, partialText: 'private preview' };
    if (kind === 'legacy-error') ctx.stderrBuf = 'fixture failure';
    if (kind === 'legacy-stall') ctx.stallReason = 'no output for 900s';
    return {
        ctx, code: kind === 'legacy-error' || kind === 'legacy-stall' ? 1 : 0,
        cli: 'codex-app', model: 'fixture', resumeKey: null, agentLabel: 'main', mainManaged: true,
        origin: 'web', prompt: 'fixture', opts: { _skipSessionPersist: true, _isSmokeContinuation: true }, cfg: {},
        ownerGeneration: 0, persistenceOwner: { global: 0, scope: 0 }, forceNew: false, empSid: null,
        isResume: false, wasKilled: kind === 'legacy-stall', wasSteer: false,
        smokeResult: { isSmoke: false, confidence: 'low', matchedPattern: null, reason: '' },
        effortDefault: '', costLine: '', resolve() {}, activeProcesses: new Map(),
        scopeKey: id, chatSessionId: id, childProcess: null,
        releaseMainRun: () => {
            if (native) ctx.traceRunId = 'replacement-owner-must-not-leak';
            return false;
        },
        retryState: { setTimer() {}, setResolve() {}, setOrigin() {}, setIsEmployee() {} },
        fallbackState: new Map(), fallbackMaxRetries: 0, processQueue() {},
    };
}

for (const kind of ['legacy-done', 'legacy-error', 'legacy-stall', 'native-done', 'native-error', 'native-stopped']) {
    test(`RID-001 ${kind} terminal retains its owning trace identity`, async () => {
        const params = lifecycle(kind), expected = params.ctx.traceRunId;
        const terminals: Record<string, unknown>[] = [];
        const listener = (type: string, data: Record<string, unknown>) => {
            if (type === 'agent_done') terminals.push(data);
        };
        addBroadcastListener(listener);
        try { await handleAgentExit(params); }
        finally { removeBroadcastListener(listener); }
        assert.equal(terminals.length, 1);
        assert.equal(terminals[0]?.['traceRunId'], expected);
        if (kind.startsWith('native')) assert.equal(params.ctx.traceRunId, 'replacement-owner-must-not-leak', 'mutation seam executed');
    });
}

for (const withTools of [false, true]) {
    test(`F9 ${withTools ? 'lazy tool-backed' : 'live'} VS promotion removes transient Mermaid queue metadata before snapshot`, async t => {
        const { getVirtualScroll } = await import('../../public/js/virtual-scroll.ts');
        const vs = getVirtualScroll();
        vs.clear();
        const container = document.getElementById('chatMessages')!;
        // jsdom lacks the browser scrollTo API; rendering and snapshots remain real.
        Object.defineProperty(container, 'scrollTo', { configurable: true, value() {} });
        vs.setItems([{ id: 'existing-item', html: '<div class="msg">history</div>', height: 80 }]);
        assert.equal(vs.active, true);
        ui.appendAgentText('preview');
        const div = state.currentAgentDiv!;
        assert.equal(div.isConnected, true);
        const queued = document.createElement('div');
        queued.className = 'mermaid-pending';
        queued.dataset['mermaidQueued'] = '1';
        queued.dataset['mermaidQueuedAt'] = '100';
        queued.dataset['mermaidCodeRaw'] = 'Z3JhcGggVEQ7QTtC';
        // A prior diagram in the agent body/tool area survives replacement of
        // the answer's .msg-content. Its queue ownership must not survive VS.
        div.querySelector('.agent-body')!.prepend(queued);
        const snapshots: string[] = [];
        const live = vs.appendLiveItem.bind(vs);
        const lazy = vs.appendItem.bind(vs);
        t.mock.method(vs, 'appendLiveItem', node => { snapshots.push(node.outerHTML); live(node); });
        t.mock.method(vs, 'appendItem', item => { snapshots.push(div.outerHTML); lazy(item); });
        try {
            ui.finalizeAgent('final answer', withTools ? [{ label: 'Tool', detail: 'done', status: 'done' }] : [], 'present');
            assert.equal(snapshots.length, 1, 'the intended promotion path executed');
            assert.equal(vs.count, 2);
            const captured = document.createElement('div');
            captured.innerHTML = snapshots[0]!;
            const diagram = captured.querySelector<HTMLElement>('.mermaid-pending');
            assert.ok(diagram, 'the seeded diagram reached the snapshot boundary');
            assert.equal(diagram.dataset['mermaidQueued'], undefined);
            assert.equal(diagram.dataset['mermaidQueuedAt'], undefined);
            assert.equal(diagram.dataset['mermaidCodeRaw'], 'Z3JhcGggVEQ7QTtC', 'diagram source is retained');
            assert.equal(state.currentAgentDiv, null);
        } finally {
            vs.clear();
        }
    });
}
