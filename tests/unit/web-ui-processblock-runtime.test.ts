import test from 'node:test';
import assert from 'node:assert/strict';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';

test.afterEach(() => {
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
