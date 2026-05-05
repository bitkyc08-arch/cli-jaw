import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Phase 127 (#127) mermaid render latency — source-string contract for ui.ts.

const uiSrc = readFileSync(
    join(import.meta.dirname, '../../public/js/ui.ts'),
    'utf8',
);
const mainSrc = readFileSync(
    join(import.meta.dirname, '../../public/js/main.ts'),
    'utf8',
);

test('F5: finalizeAgent triggers immediate mermaid render after innerHTML', () => {
    const idx = uiSrc.indexOf('export function finalizeAgent');
    assert.ok(idx >= 0, 'finalizeAgent must exist');
    const block = uiSrc.slice(idx, idx + 3500);
    assert.ok(block.includes('renderMermaidBlocks('),
        'finalizeAgent must call renderMermaidBlocks to bypass the 100ms debounce');
    assert.ok(block.includes('immediate: true'),
        'finalizeAgent mermaid call must use immediate mode');
});

test('F9: VS promotion clears transient mermaid queue state before snapshot', () => {
    assert.ok(uiSrc.includes('function clearMermaidTransientState'),
        'ui.ts must define a helper that clears transient Mermaid state');
    const idx = uiSrc.indexOf('export function finalizeAgent');
    assert.ok(idx >= 0, 'finalizeAgent must exist');
    const block = uiSrc.slice(idx, idx + 4200);
    const clearIdx = block.indexOf('clearMermaidTransientState(div)');
    const appendLiveIdx = block.indexOf('vs.appendLiveItem(div)');
    const appendLazyIdx = block.indexOf('vs.appendItem(buildLazyVirtualMessageItem');
    const appendIdx = appendLiveIdx >= 0 && appendLazyIdx >= 0
        ? Math.min(appendLiveIdx, appendLazyIdx)
        : Math.max(appendLiveIdx, appendLazyIdx);
    assert.ok(clearIdx >= 0, 'finalizeAgent must clear Mermaid transient state');
    assert.ok(appendIdx >= 0, 'finalizeAgent must append to Virtual Scroll');
    assert.ok(clearIdx < appendIdx,
        'transient Mermaid state must be cleared before VS snapshots outerHTML');
});

test('F9: finalizeAgent skips immediate Mermaid queue for DOM promoted to VS', () => {
    const idx = uiSrc.indexOf('export function finalizeAgent');
    assert.ok(idx >= 0, 'finalizeAgent must exist');
    const block = uiSrc.slice(idx, idx + 4200);
    assert.ok(block.includes('willPromoteToVirtualScroll'),
        'finalizeAgent must compute the VS promotion condition before Mermaid rendering');
    assert.ok(/if\s*\(\s*content\s*&&\s*!willPromoteToVirtualScroll\s*\)/.test(block),
        'immediate Mermaid render must be skipped for DOM that will be promoted to VS');
});

test('F7a: VS onLazyRender triggers immediate mermaid render', () => {
    const idx = uiSrc.indexOf('vs.onLazyRender = ');
    assert.ok(idx >= 0, 'onLazyRender assignment must exist');
    const block = uiSrc.slice(idx, idx + 1800);
    assert.ok(block.includes('renderMermaidBlocks('),
        'onLazyRender must trigger mermaid render on fresh markdown');
    assert.ok(block.includes('immediate: true'),
        'onLazyRender mermaid call must use immediate mode');
});

test('F7b: VS onPostRender triggers immediate mermaid render for mounted scope', () => {
    const idx = uiSrc.indexOf('vs.onPostRender = ');
    assert.ok(idx >= 0, 'onPostRender assignment must exist');
    const block = uiSrc.slice(idx, idx + 800);
    assert.ok(block.includes('renderMermaidBlocks('),
        'onPostRender must trigger mermaid render for pre-rendered pending blocks');
    assert.ok(block.includes('immediate: true'),
        'onPostRender mermaid call must use immediate mode');
    assert.ok(/renderMermaidBlocks\(\s*viewport/.test(block),
        'onPostRender must scope the mermaid render to the viewport argument');
});

test('imports: renderMermaidBlocks is imported in ui.ts without touching existing render import', () => {
    assert.ok(uiSrc.includes("import { renderMermaidBlocks } from './render.js';"),
        'renderMermaidBlocks must be imported on its own line from ./render.js');
    // Existing import must remain intact
    assert.ok(
        uiSrc.includes("import { renderMarkdown, escapeHtml, sanitizeHtml, stripOrchestration, linkifyFilePaths } from './render.js';"),
        'original render.js import line must be preserved untouched',
    );
    // activateWidgets must still come from iframe-renderer
    assert.ok(
        uiSrc.includes("import { activateWidgets } from './diagram/iframe-renderer.js';"),
        'activateWidgets must stay imported from ./diagram/iframe-renderer.js',
    );
});

test('F2: main.ts imports prewarmMermaid and calls it in bootstrap', () => {
    assert.ok(
        mainSrc.includes("import { prewarmMermaid } from './render.js';"),
        'main.ts must import prewarmMermaid from ./render.js',
    );
    const bootstrapIdx = mainSrc.indexOf('async function bootstrap()');
    assert.ok(bootstrapIdx >= 0, 'bootstrap function must exist');
    const bootstrapBlock = mainSrc.slice(bootstrapIdx, bootstrapIdx + 2500);
    assert.ok(bootstrapBlock.includes('prewarmMermaid();'),
        'bootstrap must call prewarmMermaid()');
});
