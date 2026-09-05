import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Remaining Phase 127 (#127) Mermaid source contracts.

const uiSrc = readFileSync(
    join(import.meta.dirname, '../../public/js/ui.ts'),
    'utf8',
);
const historySrc = readFileSync(
    join(import.meta.dirname, '../../public/js/features/message-history.ts'),
    'utf8',
);
const mainSrc = readFileSync(
    join(import.meta.dirname, '../../public/js/main.ts'),
    'utf8',
);

// F5 and exact-import spelling checks are replaced by web-final-answer-render.test.ts:
// real finalizeAgent/replaceAgentAnswer render Markdown before scoped widget activation
// and renderMermaidBlocks(content, { immediate: true }). Import grouping is not behavior.

// F9 promotion is driven through the real finalizer/VS snapshot boundary in
// web-replay-behavior.test.ts. A fixed byte window cannot prove call ordering.

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
    const idx = historySrc.indexOf('vs.onLazyRender = ');
    assert.ok(idx >= 0, 'onLazyRender assignment must exist');
    const block = historySrc.slice(idx, idx + 1800);
    assert.ok(block.includes('renderMermaidBlocks('),
        'onLazyRender must trigger mermaid render on fresh markdown');
    assert.ok(block.includes('immediate: true'),
        'onLazyRender mermaid call must use immediate mode');
});

test('F7b: VS onPostRender triggers immediate mermaid render for mounted scope', () => {
    const idx = historySrc.indexOf('vs.onPostRender = ');
    assert.ok(idx >= 0, 'onPostRender assignment must exist');
    const block = historySrc.slice(idx, idx + 800);
    assert.ok(block.includes('renderMermaidBlocks('),
        'onPostRender must trigger mermaid render for pre-rendered pending blocks');
    assert.ok(block.includes('immediate: true'),
        'onPostRender mermaid call must use immediate mode');
    assert.ok(/renderMermaidBlocks\(\s*viewport/.test(block),
        'onPostRender must scope the mermaid render to the viewport argument');
});

test('F2: main.ts imports prewarmMermaid and calls it in bootstrap', () => {
    assert.ok(
        mainSrc.includes("import { prewarmMermaid } from './render.js';"),
        'main.ts must import prewarmMermaid from ./render.js',
    );
    const bootstrapIdx = mainSrc.indexOf('async function bootstrap()');
    assert.ok(bootstrapIdx >= 0, 'bootstrap function must exist');
    // Extract the bootstrap body by brace matching rather than a byte window:
    // the old fixed 2500-byte slice measured how much code precedes the call
    // (phase 071 pushed it to 2618), while slicing to EOF would let an
    // unrelated later call satisfy this guard.
    const bodyStart = mainSrc.indexOf('{', bootstrapIdx);
    assert.ok(bodyStart > 0, 'bootstrap body must exist');
    let depth = 0;
    let bodyEnd = bodyStart;
    for (let i = bodyStart; i < mainSrc.length; i += 1) {
        if (mainSrc[i] === '{') depth += 1;
        else if (mainSrc[i] === '}') {
            depth -= 1;
            if (depth === 0) { bodyEnd = i; break; }
        }
    }
    assert.ok(bodyEnd > bodyStart, 'bootstrap body must be balanced');
    const bootstrapBlock = mainSrc.slice(bodyStart, bodyEnd);
    assert.ok(bootstrapBlock.includes('prewarmMermaid();'),
        'bootstrap must call prewarmMermaid()');
});
