import test from 'node:test';
import assert from 'node:assert/strict';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';

test.afterEach(() => {
    resetWebUiDom();
});

test('ProcessBlock keeps huge details out of collapsed state and hydrates lazily', async () => {
    setupWebUiDom();
    const {
        buildProcessBlockHtml,
        bindProcessBlockInteractions,
        getStoredProcessStepDetail,
        releaseProcessBlockDetails,
    } = await import('../../public/js/features/process-block.ts');

    const huge = 'DETAIL-'.repeat(20_000);
    const host = document.createElement('div');
    host.innerHTML = buildProcessBlockHtml([{
        id: 'step-huge',
        type: 'tool',
        icon: 'tool',
        label: 'Huge tool',
        detail: huge,
        status: 'done',
        startTime: Date.now(),
    }], true);
    document.body.appendChild(host);
    const block = host.querySelector('.process-block') as HTMLElement;
    const pre = block.querySelector('.process-step-full') as HTMLElement;

    assert.ok(block.dataset.processStepIds?.includes('step-huge'));
    assert.equal(pre.textContent, '');
    assert.equal(pre.dataset.detailLazy, 'true');
    assert.ok(!block.outerHTML.includes(huge.slice(0, 2000)));
    assert.ok(getStoredProcessStepDetail('step-huge').length < huge.length);

    bindProcessBlockInteractions(block);
    (block.querySelector('.process-step-toggle') as HTMLButtonElement).click();
    assert.ok((block.querySelector('.process-step-full') as HTMLElement).textContent!.includes('DETAIL-'));

    (block.querySelector('.process-step-toggle') as HTMLButtonElement).click();
    assert.equal((block.querySelector('.process-step-full') as HTMLElement).textContent, '');

    releaseProcessBlockDetails(block);
    assert.equal(getStoredProcessStepDetail('step-huge'), '');
});
