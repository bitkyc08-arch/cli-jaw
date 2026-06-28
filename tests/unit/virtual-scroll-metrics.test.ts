import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const virtualScrollSource = readFileSync(join(__dirname, '../../public/js/virtual-scroll.ts'), 'utf8');

// Phase 30 measurement coverage. The tanstack virtualizer cannot fully mount rows
// under jsdom, so we assert the deterministic empty-instance state plus the source
// presence of metrics() — the same source-assert technique the existing
// virtual-scroll-regression test uses.

test.afterEach(() => {
    resetWebUiDom();
});

test('VirtualScroll.metrics() exists in source', () => {
    assert.ok(virtualScrollSource.includes('metrics()'), 'metrics() method must exist');
    assert.ok(virtualScrollSource.includes('mountedRowCount'), 'metrics must report mountedRowCount');
    assert.ok(virtualScrollSource.includes('virtualItemCount'), 'metrics must report virtualItemCount');
});

test('VirtualScroll.metrics() returns a zeroed snapshot on an empty instance', async () => {
    setupWebUiDom();
    const container = document.createElement('div');
    container.id = 'vs-metrics-test-container';
    document.body.appendChild(container);

    const { VirtualScroll } = await import('../../public/js/virtual-scroll.ts');
    const vs = new VirtualScroll('vs-metrics-test-container');

    assert.deepEqual(vs.metrics(), {
        virtualItemCount: 0,
        mountedRowCount: 0,
        firstVisibleIdx: null,
        lastVisibleIdx: null,
        firstVisibleId: null,
        lastVisibleId: null,
    });
});
