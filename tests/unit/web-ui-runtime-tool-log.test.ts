import test from 'node:test';
import assert from 'node:assert/strict';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';

test.afterEach(() => {
    resetWebUiDom();
});

test('persisted tool log can render as a lazy ProcessBlock before msg-content', async () => {
    setupWebUiDom();
    const { buildProcessBlockHtml } = await import('../../public/js/features/process-block.ts');

    const body = document.createElement('div');
    body.className = 'agent-body';
    body.dataset.toolLog = JSON.stringify([
        { toolType: 'subagent', label: 'Worker', detail: '<done & quoted>', status: 'done', stepRef: 'subagent-1' },
    ]);
    body.innerHTML = '<div class="msg-content lazy-pending" data-raw="hello"></div>';

    const rawToolLog = body.dataset.toolLog || '';
    const tools = JSON.parse(rawToolLog);
    const content = body.querySelector('.msg-content') as HTMLElement;
    content.insertAdjacentHTML('beforebegin', buildProcessBlockHtml(tools.map((tool: any) => ({
        id: `step-${tool.stepRef}`,
        type: tool.toolType,
        icon: 'robot',
        label: tool.label,
        detail: tool.detail,
        stepRef: tool.stepRef,
        status: tool.status,
        startTime: Date.now(),
    })), true));
    delete body.dataset.toolLog;

    assert.equal(body.dataset.toolLog, undefined);
    assert.equal(body.firstElementChild?.classList.contains('process-block'), true);
    assert.equal(body.querySelector('.msg-content > .process-block'), null);
    assert.equal(body.querySelector('.process-step')?.getAttribute('data-type'), 'subagent');
    assert.match(body.textContent || '', /<done & quoted>/);
});
