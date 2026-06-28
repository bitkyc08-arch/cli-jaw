import test from 'node:test';
import assert from 'node:assert/strict';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';

// Phase 30 measurement coverage: the release/reconstruct counters expose the
// ProcessBlock memory-policy hot paths without changing behavior.

test.afterEach(() => {
    resetWebUiDom();
});

test('releaseProcessBlockDetails increments call + cleared-id counters', async () => {
    setupWebUiDom();
    const {
        buildProcessBlockHtml,
        releaseProcessBlockDetails,
        getProcessBlockMetrics,
        resetProcessBlockMetrics,
    } = await import('../../public/js/features/process-block.ts');

    resetProcessBlockMetrics();
    assert.deepEqual(getProcessBlockMetrics(), {
        releaseDetailsCalls: 0, releaseDetailsIdsCleared: 0, reconstructCalls: 0, reconstructStepsBuilt: 0,
    });

    const host = document.createElement('div');
    host.innerHTML = buildProcessBlockHtml([{
        id: 'step-metric',
        type: 'tool',
        icon: 'tool',
        label: 'Metric tool',
        detail: 'some detail body',
        detailAvailable: true,
        detailBytes: 16,
        status: 'done',
        startTime: Date.now(),
    }], true);
    document.body.appendChild(host);

    releaseProcessBlockDetails(host);
    const after = getProcessBlockMetrics();
    assert.equal(after.releaseDetailsCalls, 1, 'one real release call counted');
    assert.ok(after.releaseDetailsIdsCleared >= 1, 'at least one id cleared counted');
});

test('releaseProcessBlockDetails(null) is a no-op and is not counted', async () => {
    setupWebUiDom();
    const { releaseProcessBlockDetails, getProcessBlockMetrics, resetProcessBlockMetrics } =
        await import('../../public/js/features/process-block.ts');

    resetProcessBlockMetrics();
    releaseProcessBlockDetails(null);
    releaseProcessBlockDetails(undefined);
    assert.equal(getProcessBlockMetrics().releaseDetailsCalls, 0, 'guarded no-op must not be counted');
});

test('reconstructStepsFromBlock increments call + built-step counters', async () => {
    setupWebUiDom();
    const {
        buildProcessBlockHtml,
        reconstructStepsFromBlock,
        getProcessBlockMetrics,
        resetProcessBlockMetrics,
    } = await import('../../public/js/features/process-block.ts');

    const host = document.createElement('div');
    host.innerHTML = buildProcessBlockHtml([{
        id: 'step-recon',
        type: 'tool',
        icon: 'tool',
        label: 'Recon tool',
        detail: 'detail for reconstruct',
        detailAvailable: true,
        detailBytes: 22,
        status: 'done',
        startTime: Date.now(),
    }], true);
    document.body.appendChild(host);
    const block = host.querySelector('.process-block') as HTMLElement;

    resetProcessBlockMetrics();
    const steps = reconstructStepsFromBlock(block);
    const after = getProcessBlockMetrics();
    assert.equal(after.reconstructCalls, 1, 'one reconstruct call counted');
    assert.equal(after.reconstructStepsBuilt, steps.length, 'built-step counter matches returned length');
});
