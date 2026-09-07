// ── Frontend rendering hot-path performance contracts ──

// H1: scrollToBottom batches the virtual-scroll branch under the same rAF
//     gate as the direct-DOM branch (was: sync scrollToIndex per token chunk).
// H2: addStep past the render cap appends incrementally (append + evict +
//     omitted-count patch) instead of full renderSteps() per event.
// H4: streaming re-render throttle scales with accumulated text length.
// M2: sanitizeCssInStyleTags short-circuits when no <style> is present.
// M5: hot events (agent_tool/agent_output) head the ws dispatcher chain.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '../..');
const chatScrollSrc = readFileSync(join(root, 'public/js/features/chat-scroll.ts'), 'utf8');
const processBlockSrc = readFileSync(join(root, 'public/js/features/process-block.ts'), 'utf8');
const streamingSrc = readFileSync(join(root, 'public/js/streaming-render.ts'), 'utf8');
const sanitizeSrc = readFileSync(join(root, 'public/js/render/sanitize.ts'), 'utf8');
const wsSrc = readFileSync(join(root, 'public/js/ws.ts'), 'utf8');
const postRenderSrc = readFileSync(join(root, 'public/js/render/post-render.ts'), 'utf8');

test('PERF-001: scrollToBottom VS branch is inside the rAF gate, not before it', () => {
    const fnIdx = chatScrollSrc.indexOf('export function scrollToBottom(');
    const fnBlock = chatScrollSrc.slice(fnIdx, chatScrollSrc.indexOf('\n}', fnIdx));
    const rafIdx = fnBlock.indexOf('requestAnimationFrame');
    assert.ok(rafIdx > 0, 'scrollToBottom must schedule via rAF');
    const beforeRaf = fnBlock.slice(0, rafIdx);
    assert.ok(!beforeRaf.includes('vs.scrollToBottom()'),
        'VS scroll must not run synchronously before the rAF gate');
    const afterRaf = fnBlock.slice(rafIdx);
    assert.ok(afterRaf.includes('getVirtualScroll()'),
        'VS active state must be re-read inside the rAF callback');
    assert.ok(afterRaf.includes('vs.scrollToBottom()'), 'VS branch still bottoms inside the frame');
});

test('PERF-002: addStep past the cap appends + evicts instead of full renderSteps', () => {
    const fnIdx = processBlockSrc.indexOf('export function addStep(');
    const fnBlock = processBlockSrc.slice(fnIdx, processBlockSrc.indexOf('\n}', fnIdx));
    assert.ok(fnBlock.includes('PROCESS_BLOCK_MAX_RENDERED_STEPS + 1'),
        'exactly one full render establishes the elided structure');
    assert.ok(fnBlock.includes('evictExitingTailStep('),
        'subsequent appends evict the step exiting the tail window');
    assert.ok(processBlockSrc.includes('function evictExitingTailStep('), 'evict helper exists');
    assert.ok(processBlockSrc.includes('function updateOmittedButtonCount('),
        'omitted-button count is patched incrementally');
    assert.ok(processBlockSrc.includes("status === 'running' || exiting.status === 'error'")
        || processBlockSrc.includes("exiting.status === 'running' || exiting.status === 'error'"),
        'running/error steps stay visible (same exception as visibleStepIndexes)');
});

test('PERF-003: streaming throttle adapts to accumulated text length', () => {
    assert.ok(streamingSrc.includes('function throttleMsFor('), 'adaptive throttle helper exists');
    assert.ok(streamingSrc.includes('THROTTLE_MAX_MS'), 'throttle is capped');
    assert.ok(streamingSrc.includes('throttleMsFor(text.length)'),
        'render gate uses the adaptive interval');
});

test('PERF-004: sanitizeCssInStyleTags short-circuits without <style>', () => {
    const fnIdx = sanitizeSrc.indexOf('function sanitizeCssInStyleTags(');
    const fnBlock = sanitizeSrc.slice(fnIdx, sanitizeSrc.indexOf('\n}', fnIdx));
    const precheckIdx = fnBlock.indexOf('/<style/i.test(html)');
    const parseIdx = fnBlock.indexOf('div.innerHTML = html');
    assert.ok(precheckIdx > 0, 'cheap regex precheck exists');
    assert.ok(parseIdx > precheckIdx, 'precheck runs before the DOM parse round-trip');
});

test('PERF-005: hot events head the ws dispatcher; slice-contract order preserved', () => {
    const dispatchIdx = wsSrc.indexOf('function handleServerEvent(');
    const toolIdx = wsSrc.indexOf("msg.type === 'agent_tool'", dispatchIdx);
    const outIdx = wsSrc.indexOf("msg.type === 'agent_output'", dispatchIdx);
    const retryIdx = wsSrc.indexOf("msg.type === 'agent_retry'", dispatchIdx);
    const statusIdx = wsSrc.indexOf("msg.type === 'agent_status'", dispatchIdx);
    assert.ok(toolIdx > 0 && outIdx > toolIdx && retryIdx > outIdx,
        'textual order agent_tool < agent_output < agent_retry (RID slice contract)');
    assert.ok(toolIdx < statusIdx, 'hot agent_tool branch precedes cold agent_status branch');
});

test('PERF-006: post-render container-wide scans are gated by candidate checks', () => {
    const fnIdx = postRenderSrc.indexOf('export function schedulePostRender(');
    const fnBlock = postRenderSrc.slice(fnIdx);
    assert.ok(fnBlock.includes(".querySelector('.mermaid-pending"), 'mermaid scan gated');
    assert.ok(fnBlock.includes('rehighlightAll()'), 'highlight call retained');
    assert.ok(fnBlock.includes('hydrateElicitationBlocks(msgContainer)'),
        'renderer-contract hydrate calls remain unconditional');
});
