import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';
import { bindProcessBlockInteractions, stopBlockTicker } from '../../public/js/features/process-block.ts';

test.afterEach(() => {
    stopBlockTicker();
    window.__jawProcessBlockLayoutMutation = undefined;
    resetWebUiDom();
});

test('hydrateActiveRun is idempotent for process block ownership', async () => {
    setupWebUiDom();
    const ui = await import('../../public/js/ui.ts');
    const snapshot = {
        running: true,
        cli: 'codex',
        text: 'working',
        toolLog: [
            { toolType: 'subagent', label: 'Subagent', detail: 'started', status: 'running', stepRef: 'subagent-1' },
        ],
    };

    ui.hydrateActiveRun(snapshot);
    ui.hydrateActiveRun(snapshot);

    assert.equal(document.querySelectorAll('.msg-agent .agent-body > .process-block').length, 1);
    assert.equal(document.querySelectorAll('.msg-agent .msg-content > .process-block').length, 0);
});

test('new live stream starts a fresh agent bubble after a later user message', async () => {
    setupWebUiDom();
    const ui = await import('../../public/js/ui.ts');
    const { state } = await import('../../public/js/state.ts');
    const container = document.getElementById('chatMessages');
    assert.ok(container);
    container.innerHTML = `
        <div class="msg msg-agent">
            <div class="agent-body"><div class="msg-content">previous answer</div></div>
        </div>
        <div class="msg msg-user">
            <div class="user-body"><div class="msg-content">new prompt</div></div>
        </div>
    `;
    const previous = container.querySelector('.msg-agent') as HTMLElement;
    state.currentAgentDiv = previous;

    ui.appendAgentText('new streamed text');
    await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));

    const agents = [...document.querySelectorAll<HTMLElement>('.msg-agent')];
    assert.equal(agents.length, 2);
    assert.match(agents[0]?.querySelector('.msg-content')?.textContent || '', /previous answer/);
    assert.doesNotMatch(agents[0]?.querySelector('.msg-content')?.textContent || '', /new streamed text/);
    assert.match(agents[1]?.querySelector('.msg-content')?.textContent || '', /new streamed text/);
});

test('hydrateActiveRun preserves employee origin without polluting raw label', async () => {
    setupWebUiDom();
    const ui = await import('../../public/js/ui.ts');
    const snapshot = {
        running: true,
        cli: 'codex',
        text: 'working',
        toolLog: [
            { toolType: 'tool', label: 'read_file', detail: 'started', status: 'running', isEmployee: true },
        ],
    };

    ui.hydrateActiveRun(snapshot);

    assert.equal(document.querySelectorAll('.process-step-origin').length, 1);
    assert.equal(document.querySelector('.process-step-origin')?.textContent, '(E)');
    assert.equal(document.querySelector('.process-step-label')?.textContent, 'read_file');
    assert.doesNotMatch(document.querySelector('.process-step-label')?.textContent || '', /\(E\)/);
});

test('DOM-derived ProcessBlock row is reused by matching stepRef completion', async () => {
    setupWebUiDom();
    const ui = await import('../../public/js/ui.ts');
    const { state } = await import('../../public/js/state.ts');

    const msg = ui.addMessage('agent', '');
    const body = msg.querySelector('.agent-body') as HTMLElement;
    body.insertAdjacentHTML('afterbegin', `
        <div class="process-block">
            <button class="process-summary" aria-expanded="true"></button>
            <div class="process-details">
                <div class="process-steps-inner">
                    <div class="process-step process-step-expandable"
                        data-step-id="row-1"
                        data-type="subagent"
                        data-status="running"
                        data-step-ref="subagent-1"
                        data-start-time="123">
                        <button class="process-step-toggle" aria-expanded="false">
                            <span class="process-step-dot running"></span>
                            <span class="process-step-icon" aria-hidden="true">robot</span>
                            <span class="process-step-badge subagent">SUBAGENT</span>
                            <span class="process-step-main">
                                <span class="process-step-label">Worker</span>
                            </span>
                        </button>
                        <div class="process-step-details collapsed">
                            <pre class="process-step-full">started</pre>
                        </div>
                    </div>
                </div>
            </div>
        </div>`);
    state.currentAgentDiv = msg;
    state.currentProcessBlock = null;

    ui.showProcessStep({
        id: 'done-1',
        type: 'subagent',
        icon: '✅',
        label: 'Worker',
        detail: 'finished',
        stepRef: 'subagent-1',
        status: 'done',
        startTime: Date.now(),
    });

    assert.equal(msg.querySelectorAll('.process-step').length, 1);
    const row = msg.querySelector('.process-step') as HTMLElement;
    assert.equal(row.dataset.status, 'done');
    assert.match(row.textContent || '', /finished/);
});

test('DOM-derived employee row re-renders one marker and keeps raw label', async () => {
    setupWebUiDom();
    const ui = await import('../../public/js/ui.ts');
    const { state } = await import('../../public/js/state.ts');

    const msg = ui.addMessage('agent', '');
    const body = msg.querySelector('.agent-body') as HTMLElement;
    body.insertAdjacentHTML('afterbegin', `
        <div class="process-block">
            <button class="process-summary" aria-expanded="true"></button>
            <div class="process-details">
                <div class="process-steps-inner">
                    <div class="process-step process-step-expandable"
                        data-step-id="row-emp"
                        data-type="tool"
                        data-status="running"
                        data-is-employee="true"
                        data-step-ref="tool-1"
                        data-start-time="123">
                        <button class="process-step-toggle" aria-expanded="false">
                            <span class="process-step-dot running"></span>
                            <span class="process-step-icon" aria-hidden="true">tool</span>
                            <span class="process-step-badge tool">TOOL</span>
                            <span class="process-step-main">
                                <span class="process-step-origin" aria-label="Employee tool">(E)</span>
                                <span class="process-step-label">read_file</span>
                            </span>
                        </button>
                        <div class="process-step-details collapsed">
                            <pre class="process-step-full">started</pre>
                        </div>
                    </div>
                </div>
            </div>
        </div>`);
    state.currentAgentDiv = msg;
    state.currentProcessBlock = null;

    ui.showProcessStep({
        id: 'done-emp',
        type: 'tool',
        icon: '✅',
        label: 'read_file',
        detail: 'finished',
        stepRef: 'tool-1',
        isEmployee: true,
        status: 'done',
        startTime: Date.now(),
    });

    assert.equal(msg.querySelectorAll('.process-step-origin').length, 1);
    assert.equal(msg.querySelector('.process-step-label')?.textContent, 'read_file');
    assert.doesNotMatch(msg.querySelector('.process-step-label')?.textContent || '', /\(E\)/);
});

test('employee detail rebroadcast does not replace non-employee ghost row', async () => {
    setupWebUiDom();
    const ui = await import('../../public/js/ui.ts');

    ui.showProcessStep({
        id: 'boss-running',
        type: 'tool',
        icon: 'tool',
        label: 'read_file',
        status: 'running',
        startTime: Date.now(),
    });
    ui.showProcessStep({
        id: 'employee-detail',
        type: 'tool',
        icon: 'tool',
        label: 'read_file',
        detail: 'employee detail',
        isEmployee: true,
        status: 'running',
        startTime: Date.now(),
    });

    assert.equal(document.querySelectorAll('.process-step').length, 2);
    assert.equal(document.querySelectorAll('.process-step-origin').length, 1);
    assert.equal(document.querySelectorAll('.process-step-label')[0]?.textContent, 'read_file');
    assert.equal(document.querySelectorAll('.process-step-label')[1]?.textContent, 'read_file');
});

test('running ProcessBlock updates with same stepRef replace one row instead of counting duplicates', async () => {
    setupWebUiDom();
    const ui = await import('../../public/js/ui.ts');

    ui.showProcessStep({
        id: 'thinking-start',
        type: 'thinking',
        icon: '💭',
        label: 'Grok thinking',
        detail: 'First chunk',
        stepRef: 'grok:thinking',
        status: 'running',
        startTime: Date.now(),
    });
    ui.showProcessStep({
        id: 'thinking-update',
        type: 'thinking',
        icon: '💭',
        label: 'Grok thinking',
        detail: 'First chunk plus more detail',
        stepRef: 'grok:thinking',
        status: 'running',
        startTime: Date.now(),
    });

    assert.equal(document.querySelectorAll('.process-step').length, 1);
    assert.equal(document.querySelector('.process-summary-text')?.textContent?.includes('Thinking×2'), false);
    assert.match(document.querySelector('.process-step')?.textContent || '', /First chunk plus more detail/);
});

test('ProcessBlock toggles pass row anchor through layout mutation hook', () => {
    setupWebUiDom();
    const host = document.createElement('div');
    host.innerHTML = `
        <div class="process-block">
            <button class="process-summary" aria-expanded="true">
                <span class="process-chevron"></span>
            </button>
            <div class="process-details">
                <div class="process-steps-inner">
                    <div class="process-step process-step-expandable" data-step-id="row-anchor">
                        <button class="process-step-toggle" aria-expanded="false">
                            <span class="process-step-chevron"></span>
                        </button>
                        <div class="process-step-details collapsed">
                            <pre class="process-step-full">detail</pre>
                        </div>
                    </div>
                </div>
            </div>
        </div>`;
    document.body.appendChild(host);
    const block = host.querySelector('.process-block') as HTMLElement;
    const anchors: Array<Element | null> = [];
    window.__jawProcessBlockLayoutMutation = (anchor, mutate) => {
        anchors.push(anchor);
        mutate();
    };

    bindProcessBlockInteractions(block);
    (block.querySelector('.process-step-toggle') as HTMLButtonElement).click();
    (block.querySelector('.process-summary') as HTMLButtonElement).click();

    assert.equal(anchors.length, 2);
    assert.equal(anchors[0]?.classList.contains('process-step'), true);
    assert.equal(anchors[1]?.classList.contains('process-block'), true);
});

test('normalization keeps top-level process-block over top-level tool-group', async () => {
    setupWebUiDom();
    const ui = await import('../../public/js/ui.ts');
    const { state } = await import('../../public/js/state.ts');

    const msg = ui.addMessage('agent', '');
    const body = msg.querySelector('.agent-body') as HTMLElement;
    const content = body.querySelector('.msg-content') as HTMLElement;
    body.insertAdjacentHTML('afterbegin', '<div class="tool-group">legacy</div><div class="process-block">canonical</div>');
    content.insertAdjacentHTML('afterbegin', '<div class="process-block">nested</div><div class="tool-group">nested legacy</div>');
    state.currentAgentDiv = msg;

    ui.showProcessStep({
        id: 'step-1',
        type: 'tool',
        icon: 'tool',
        label: 'Tool',
        status: 'running',
        startTime: Date.now(),
    });

    assert.equal(body.querySelectorAll(':scope > .process-block, :scope > .tool-group').length, 1);
    assert.equal(body.querySelector(':scope > .process-block')?.textContent, 'canonical');
    assert.equal(content.querySelectorAll(':scope > .process-block, :scope > .tool-group').length, 0);
});

test('hydrateActiveRun reuses a restored latest assistant bubble instead of adding a second one', async () => {
    setupWebUiDom();
    const ui = await import('../../public/js/ui.ts');
    const { state } = await import('../../public/js/state.ts');
    const container = document.getElementById('chatMessages');
    assert.ok(container);
    container.innerHTML = `
        <div class="msg msg-user"><div class="user-body"><div class="msg-content">prompt</div></div></div>
        <div class="msg msg-agent">
            <div class="agent-body">
                <div class="process-block">
                    <button class="process-summary" aria-expanded="true"></button>
                    <div class="process-details"><div class="process-steps-inner"></div></div>
                </div>
                <div class="msg-content">partial answer</div>
            </div>
        </div>`;
    state.currentAgentDiv = null;
    state.currentProcessBlock = null;

    ui.hydrateActiveRun({
        running: true,
        cli: 'codex',
        text: 'partial answer',
        toolLog: [
            { toolType: 'thinking', label: 'Thinking', detail: 'snapshot', status: 'running', stepRef: 'think-1' },
        ],
    });

    assert.equal(document.querySelectorAll('.msg-agent').length, 1);
    assert.equal(document.querySelectorAll('.msg-agent .agent-body > .process-block').length, 1);
    assert.equal(document.querySelectorAll('.msg-agent .msg-content > .process-block').length, 0);
});

test('hydrateActiveRun merges snapshot rows without clobbering richer live detail', async () => {
    setupWebUiDom();
    const ui = await import('../../public/js/ui.ts');

    ui.showProcessStep({
        id: 'live-tool',
        type: 'tool',
        icon: 'tool',
        label: 'Tool',
        detail: 'live detail is longer and should remain visible',
        stepRef: 'tool-1',
        status: 'running',
        startTime: Date.now(),
    });

    ui.hydrateActiveRun({
        running: true,
        cli: 'codex',
        text: 'working',
        toolLog: [
            { toolType: 'tool', label: 'Tool', detail: 'done', status: 'done', stepRef: 'tool-1' },
            { toolType: 'thinking', label: 'Thinking', detail: 'reasoning', status: 'running', stepRef: 'think-1' },
        ],
    });

    assert.equal(document.querySelectorAll('.msg-agent .agent-body > .process-block').length, 1);
    assert.equal(document.querySelectorAll('.process-step').length, 2);
    assert.equal(document.querySelectorAll('.process-step[data-step-ref="tool-1"]').length, 1);
    assert.match(document.querySelector('.process-step[data-step-ref="tool-1"]')?.textContent || '', /live detail is longer/);
});

test('live generic tool event after hydration reuses trace identity when stepRef is absent', async () => {
    setupWebUiDom();
    const ui = await import('../../public/js/ui.ts');

    ui.hydrateActiveRun({
        running: true,
        cli: 'codex',
        text: 'working',
        toolLog: [
            { toolType: 'tool', label: 'Tool', detail: 'snapshot done', status: 'done', traceRunId: 'tr_abcdefghijklmnop', traceSeq: 7 },
        ],
    });
    ui.showProcessStep({
        id: 'live-tool',
        type: 'tool',
        icon: 'tool',
        label: 'Tool',
        detail: 'live replay detail',
        traceRunId: 'tr_abcdefghijklmnop',
        traceSeq: 7,
        status: 'running',
        startTime: Date.now(),
    });

    assert.equal(document.querySelectorAll('.msg-agent .agent-body > .process-block').length, 1);
    assert.equal(document.querySelectorAll('.msg-agent .msg-content > .process-block').length, 0);
    assert.equal(document.querySelectorAll('.process-step').length, 1);
    assert.equal(document.querySelectorAll('.process-step-label')[0]?.textContent, 'Tool');
});

test('finalizeAgent keeps one process block after hydrated tools and explicit toolLog merge', async () => {
    setupWebUiDom();
    const ui = await import('../../public/js/ui.ts');

    ui.hydrateActiveRun({
        running: true,
        cli: 'codex',
        text: 'working',
        toolLog: [
            { toolType: 'thinking', label: 'Thinking', detail: 'snapshot', status: 'running', stepRef: 'think-1' },
        ],
    });
    ui.showProcessStep({
        id: 'live-tool',
        type: 'tool',
        icon: 'tool',
        label: 'Tool',
        detail: 'live',
        stepRef: 'tool-1',
        status: 'running',
        startTime: Date.now(),
    });
    ui.finalizeAgent('final answer', [
        { toolType: 'thinking', label: 'Thinking', detail: 'snapshot', status: 'done', stepRef: 'think-1' },
        { toolType: 'tool', label: 'Tool', detail: 'live', status: 'done', stepRef: 'tool-1' },
    ]);

    assert.equal(document.querySelectorAll('.msg-agent .agent-body > .process-block').length, 1);
    assert.equal(document.querySelectorAll('.msg-agent .msg-content > .process-block').length, 0);
    assert.equal(document.querySelectorAll('.process-step').length, 2);
});

test('finalizeAgent serializes merged process state before virtual-scroll promotion', () => {
    const uiSrc = readFileSync(new URL('../../public/js/ui.ts', import.meta.url), 'utf8');
    const idx = uiSrc.indexOf('export function finalizeAgent');
    assert.ok(idx >= 0, 'finalizeAgent must exist');
    const block = uiSrc.slice(idx, uiSrc.indexOf('export function switchTab', idx));

    assert.ok(
        block.indexOf('serializeProcessStepsForToolLog(') < block.indexOf('const willPromoteToVirtualScroll'),
        'finalizeAgent must serialize merged live process state before VS promotion',
    );
    assert.ok(
        block.includes('state.currentProcessBlock ?? state.currentAgentDiv'),
        'finalizeAgent must serialize from the current block or owning agent DOM',
    );
    assert.ok(
        block.indexOf('durableToolLogJson') < block.indexOf('vs.appendItem'),
        'VS appendItem must receive already-merged durable tool log JSON',
    );
});

// ── WP3: zero-seconds timer — authoritative run-start ──

test('WP3: showProcessStep adopts the server run-start as the block elapsed origin', async () => {
    setupWebUiDom();
    const ui = await import('../../public/js/ui.ts');
    const { state } = await import('../../public/js/state.ts');
    const runStartedAt = Date.now() - 90_000; // run began 90s ago on the server

    ui.showProcessStep({
        id: 'step-a', type: 'tool', icon: '🔧', label: 'Read',
        status: 'running', startTime: Date.now(),
    }, runStartedAt);

    assert.ok(state.currentProcessBlock, 'live block exists');
    assert.equal(state.currentProcessBlock?.startedAt, runStartedAt, 'block adopts server run-start');

    // A later step must not overwrite the adopted origin.
    ui.showProcessStep({
        id: 'step-b', type: 'tool', icon: '🔧', label: 'Grep',
        status: 'running', startTime: Date.now(),
    }, Date.now());
    assert.equal(state.currentProcessBlock?.startedAt, runStartedAt, 'first run-start wins');
});

test('WP3: hydrateActiveRun stamps snapshot.startedAt on the block', async () => {
    setupWebUiDom();
    const ui = await import('../../public/js/ui.ts');
    const { state } = await import('../../public/js/state.ts');
    const startedAt = Date.now() - 45_000;

    ui.hydrateActiveRun({
        running: true, cli: 'codex', text: 'working', startedAt,
        toolLog: [{ toolType: 'tool', label: 'Read', detail: 'started', status: 'running', stepRef: 't1' }],
    });

    assert.equal(state.currentProcessBlock?.startedAt, startedAt, 'hydrated block carries run-start');
});

test('WP3: live done-update preserves the matched step startTime (no reset to now)', async () => {
    setupWebUiDom();
    const ui = await import('../../public/js/ui.ts');
    const { state } = await import('../../public/js/state.ts');
    const oldStart = Date.now() - 60_000;

    ui.showProcessStep({
        id: 'step-1', type: 'tool', icon: '🔧', label: 'Read',
        status: 'running', startTime: oldStart, stepRef: 'ref-1',
    });
    ui.showProcessStep({
        id: 'step-2', type: 'tool', icon: '✅', label: 'Read',
        status: 'done', startTime: Date.now(), stepRef: 'ref-1',
    });

    const steps = state.currentProcessBlock?.steps || [];
    assert.equal(steps.length, 1, 'done update replaced the running step');
    assert.equal(steps[0]?.startTime, oldStart, 'original startTime preserved through the merge');
    assert.equal(steps[0]?.status, 'done');
});

test('WP3: summary click syncs pb.collapsed so the ticker can run', async () => {
    setupWebUiDom();
    const ui = await import('../../public/js/ui.ts');
    const { state } = await import('../../public/js/state.ts');

    ui.showProcessStep({
        id: 'step-c', type: 'tool', icon: '🔧', label: 'Bash',
        status: 'running', startTime: Date.now() - 5_000,
    });
    const pb = state.currentProcessBlock;
    assert.ok(pb, 'live block exists');
    assert.equal(pb?.collapsed, true, 'live block starts collapsed');

    const container = document.getElementById('chatMessages') as HTMLElement;
    bindProcessBlockInteractions(container);
    const summary = pb!.element.querySelector('.process-summary') as HTMLElement;
    assert.ok(summary, 'summary exists');
    summary.dispatchEvent(new window.Event('click', { bubbles: true }));

    assert.equal(pb?.collapsed, false, 'expand click syncs state');
    assert.equal(pb?.element.classList.contains('collapsed'), false, 'DOM matches');

    summary.dispatchEvent(new window.Event('click', { bubbles: true }));
    assert.equal(pb?.collapsed, true, 'collapse click re-syncs state');
});

test('WP3: server plumbing — emitAgentTool carries ctx.runStartedAt and ws passes it through', () => {
    const helpersSrc = readFileSync(new URL('../../src/agent/events/helpers.ts', import.meta.url), 'utf8');
    assert.match(helpersSrc, /startedAt:\s*ctx\.runStartedAt/, 'agent_tool payload carries run start');
    const wsSrc = readFileSync(new URL('../../public/js/ws.ts', import.meta.url), 'utf8');
    assert.match(wsSrc, /msg\.startedAt === 'number' && msg\.startedAt > 0 \? msg\.startedAt : undefined/, 'ws forwards startedAt to showProcessStep');
    const spawnSrc = readFileSync(new URL('../../src/agent/spawn.ts', import.meta.url), 'utf8');
    assert.match(spawnSrc, /runStartedAt:\s*Date\.now\(\)/, 'spawn stamps run start on ctx');
});
