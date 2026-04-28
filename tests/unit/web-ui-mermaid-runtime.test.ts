import test from 'node:test';
import assert from 'node:assert/strict';
import { setupWebUiDom, resetWebUiDom, getUnobservedElements } from './web-ui-test-dom.ts';

test.afterEach(() => {
    resetWebUiDom();
});

test('releaseMermaidNodes releases pending queued and inflight nodes', async () => {
    setupWebUiDom();
    const { renderMermaidBlocks, releaseMermaidNodes } = await import('../../public/js/render.ts');

    const scope = document.createElement('div');
    scope.innerHTML = `
        <div id="pending" class="mermaid-pending" data-mermaid-code-raw="Z3JhcGggVEQ7QTtC"></div>
        <div id="queued" data-mermaid-queued="1" data-mermaid-code-raw="Z3JhcGggVEQ7QTtC"></div>
        <div id="inflight" data-mermaid-inflight="1" data-mermaid-code="graph TD;A;B"></div>`;
    document.body.appendChild(scope);
    await renderMermaidBlocks(scope);

    releaseMermaidNodes(scope);

    assert.ok(getUnobservedElements().length >= 1);
    for (const id of ['pending', 'queued', 'inflight']) {
        const el = document.getElementById(id) as HTMLElement;
        assert.equal(el.dataset.mermaidQueued, undefined);
        assert.equal(el.dataset.mermaidInflight, undefined);
        assert.ok(el.dataset.mermaidCodeRaw || el.dataset.mermaidCode);
    }
});
