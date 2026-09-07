// ── Live long-turn step expander ──
// A long process block elides its middle to a head/tail window for DOM/memory safety.
// pb.steps still holds EVERY step (uncapped client array), so the elided middle is now
// revealable on demand: the "Show N hidden steps" marker is a button that flips
// pb.expandedSteps and re-renders all steps. The state persists so a live turn that keeps
// streaming new steps stays expanded.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';
import {
    createProcessBlock,
    addStep,
    bindProcessBlockInteractions,
    buildProcessBlockHtml,
    releaseProcessBlockDetails,
    stopBlockTicker,
} from '../../public/js/features/process-block.ts';

test.afterEach(() => {
    stopBlockTicker();
    resetWebUiDom();
});

function makeStep(i: number) {
    return { id: `s${i}`, type: 'tool' as const, icon: '🔧', label: `tool-${i}`, status: 'done' as const, startTime: 0 };
}

function buildLongBlock(stepCount: number) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    bindProcessBlockInteractions(host);
    const pb = createProcessBlock(host);
    for (let i = 0; i < stepCount; i++) addStep(pb, makeStep(i));
    return pb;
}

test('PBX-001: long block elides the middle with a clickable expander; click reveals all', () => {
    setupWebUiDom();
    const pb = buildLongBlock(120); // > PROCESS_BLOCK_MAX_RENDERED_STEPS (80)
    const inner = pb.element.querySelector('.process-steps-inner') as HTMLElement;

    const renderedBefore = inner.querySelectorAll('[data-step-id]').length;
    const expander = inner.querySelector('[data-expand-steps]') as HTMLElement | null;
    assert.ok(renderedBefore < 120, `middle elided before expand (rendered ${renderedBefore})`);
    assert.ok(expander, 'a clickable expander button is present');

    expander!.click();

    assert.equal(inner.querySelectorAll('[data-step-id]').length, 120, 'all steps rendered after expand');
    assert.equal(inner.querySelector('[data-expand-steps]'), null, 'no omitted marker after expand');
    assert.equal(pb.expandedSteps, true, 'state set so subsequent renders stay expanded');
});

test('PBX-002: after expand, a new live step keeps the block fully expanded', () => {
    setupWebUiDom();
    const pb = buildLongBlock(120);
    (pb.element.querySelector('[data-expand-steps]') as HTMLElement).click();

    addStep(pb, makeStep(120)); // new live step arrives after expanding
    const inner = pb.element.querySelector('.process-steps-inner') as HTMLElement;
    assert.equal(inner.querySelectorAll('[data-step-id]').length, 121, 'all steps incl. the new one');
    assert.equal(inner.querySelector('[data-expand-steps]'), null, 'no re-elision after a new live step');
});

test('PBX-003: short block (<= window) renders no expander', () => {
    setupWebUiDom();
    const pb = buildLongBlock(10);
    const inner = pb.element.querySelector('.process-steps-inner') as HTMLElement;
    assert.equal(inner.querySelector('[data-expand-steps]'), null, 'no expander when nothing is elided');
    assert.equal(inner.querySelectorAll('[data-step-id]').length, 10, 'all short-block steps rendered');
});

test('PBX-004: hydrated block (absent from WeakMap) reveals all steps via dataset+meta reconstruction', () => {
    setupWebUiDom();
    const host = document.createElement('div');
    document.body.appendChild(host);
    bindProcessBlockInteractions(host);
    // Simulate history hydration / virtual-scroll rebuild: buildProcessBlockHtml renders
    // head+tail+omitted-marker and populates dataset.processStepIds + the meta store, but
    // does NOT register the block in blockStatesByElement (only createProcessBlock does, for
    // live blocks). This is exactly the c301da6c regression case.
    const steps = Array.from({ length: 120 }, (_, i) => makeStep(i));
    host.innerHTML = buildProcessBlockHtml(steps, false);
    const block = host.querySelector('.process-block') as HTMLElement;
    const inner = block.querySelector('.process-steps-inner') as HTMLElement;

    const before = inner.querySelectorAll('[data-step-id]').length;
    assert.ok(before < 120, `middle elided on hydrate (rendered ${before})`);
    assert.ok(inner.querySelector('[data-expand-steps]'), 'expander present on hydrated block');

    (inner.querySelector('[data-expand-steps]') as HTMLElement).click(); // pre-fix: WeakMap miss → no-op

    assert.equal(inner.querySelectorAll('[data-step-id]').length, 120, 'hydrated block reveals ALL steps after expand');
    assert.equal(inner.querySelector('[data-expand-steps]'), null, 'no omitted marker after expand');
});

test('PBX-005: released had-detail step shows a hint; no-detail step stays blank (Cause 2)', () => {
    setupWebUiDom();
    const host = document.createElement('div');
    document.body.appendChild(host);
    host.innerHTML = buildProcessBlockHtml([
        { id: 'has', type: 'tool', icon: '🔧', label: 'has-detail', detail: 'X'.repeat(50), status: 'done', startTime: 0 },
        { id: 'none', type: 'tool', icon: '🔧', label: 'no-detail', status: 'done', startTime: 0 },
    ], true);
    const block = host.querySelector('.process-block') as HTMLElement;
    bindProcessBlockInteractions(block);

    releaseProcessBlockDetails(block); // simulate virtual-scroll recycle: detail + meta released

    const toggles = block.querySelectorAll('.process-step-toggle');
    (toggles[0] as HTMLElement).click(); // had-detail step
    (toggles[1] as HTMLElement).click(); // no-detail step
    const pres = block.querySelectorAll('.process-step-full');
    assert.match((pres[0] as HTMLElement).textContent || '', /released to save memory/, 'had-detail step shows a hint, not a blank box');
    assert.equal((pres[1] as HTMLElement).textContent, '', 'no-detail step stays blank (no misleading hint)');
});
