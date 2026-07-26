// wp11 CF-4/CF-5/CF-6 — pane clamp, drag listener lifecycle, copy exposure.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
    CHAT_MIN,
    DIVIDER_WIDTH,
    PANE_DEFAULT,
    PANE_MIN,
    clampPaneWidth,
    paneBounds,
} from '../../public/dashboard2/src/shell/pane-bounds.ts';
import { beginPaneDrag } from '../../public/dashboard2/src/shell/pane-drag.ts';
import { copyWithFeedback } from '../../public/dashboard2/src/turn-stream/render/fences/copy-feedback.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');

test('CF-4: the pane max is the workbench minus the chat minimum and divider', () => {
    assert.deepEqual(paneBounds(1280), { min: PANE_MIN, max: 1280 - CHAT_MIN - DIVIDER_WIDTH });
});

test('CF-4: the default width is clamped on a narrow workbench', () => {
    // A 700px workbench allows at most 700-280-1=419 < PANE_DEFAULT(340)? No —
    // use one narrow enough that the max is below the default.
    const bounds = paneBounds(560); // max = 279 → clamped up to PANE_MIN
    assert.equal(bounds.max, PANE_MIN, 'the max never dips below the min');
    assert.equal(clampPaneWidth(bounds, PANE_DEFAULT), PANE_MIN, 'the default clamps into bounds');
});

test('CF-4: clamp keeps aria-valuenow inside [min, max]', () => {
    const bounds = paneBounds(1000); // max = 719
    assert.equal(clampPaneWidth(bounds, 2000), 719, 'above max clamps down');
    assert.equal(clampPaneWidth(bounds, 100), PANE_MIN, 'below min clamps up');
    assert.equal(clampPaneWidth(bounds, 400), 400, 'inside bounds passes through');
});

test('CF-4: an unmeasured workbench falls back to a conservative max', () => {
    const bounds = paneBounds(null);
    assert.ok(bounds.max >= PANE_DEFAULT, 'the fallback fits the default width');
});

test('CF-5: a drag session moves, then pointerup ends it and detaches', () => {
    const target = new EventTarget();
    let moves = 0;
    let ups = 0;
    const session = beginPaneDrag(target, {
        move: () => { moves += 1; },
        up: () => { ups += 1; },
    });
    target.dispatchEvent(new Event('pointermove'));
    assert.equal(moves, 1, 'move fires during the drag');
    target.dispatchEvent(new Event('pointerup'));
    assert.equal(ups, 1, 'pointerup ends the drag');
    target.dispatchEvent(new Event('pointermove'));
    assert.equal(moves, 1, 'no listeners remain after pointerup');
    session.dispose(); // idempotent after a natural end
});

test('CF-5: dispose mid-drag releases the document listeners (unmount safety)', () => {
    const target = new EventTarget();
    let moves = 0;
    let ups = 0;
    const session = beginPaneDrag(target, {
        move: () => { moves += 1; },
        up: () => { ups += 1; },
    });
    target.dispatchEvent(new Event('pointermove'));
    assert.equal(moves, 1);
    session.dispose(); // the component unmounts mid-drag
    target.dispatchEvent(new Event('pointermove'));
    target.dispatchEvent(new Event('pointerup'));
    assert.equal(moves, 1, 'the move listener is gone');
    assert.equal(ups, 0, 'the up handler did not fire after dispose');
    session.dispose(); // idempotent
});

test('CF-5: pointercancel also ends the drag', () => {
    const target = new EventTarget();
    let moves = 0;
    let ups = 0;
    beginPaneDrag(target, { move: () => { moves += 1; }, up: () => { ups += 1; } });
    target.dispatchEvent(new Event('pointercancel'));
    assert.equal(ups, 1);
    target.dispatchEvent(new Event('pointermove'));
    assert.equal(moves, 0, 'cancel detached the move listener');
});

test('CF-6: a copy failure resolves to a rendered message instead of rejecting', async () => {
    const outcome = await copyWithFeedback(() => Promise.reject(new Error('denied')), 'text');
    assert.deepEqual(outcome, { ok: false, message: 'denied' }, 'the failure is surfaced, not swallowed');
});

test('CF-6: a non-Error rejection still produces a message', async () => {
    const outcome = await copyWithFeedback(() => Promise.reject('nope'), 'text');
    assert.deepEqual(outcome, { ok: false, message: 'nope' });
});

test('CF-6: a successful copy resolves ok', async () => {
    const outcome = await copyWithFeedback(() => Promise.resolve(), 'text');
    assert.deepEqual(outcome, { ok: true });
});

test('the workbench and fences wire the extracted helpers', () => {
    const wb = readFileSync(join(ROOT, 'public/dashboard2/src/shell/Workbench.tsx'), 'utf8');
    assert.ok(wb.includes("from './pane-bounds.ts'"), 'the workbench imports the bounds helper');
    assert.ok(wb.includes('beginPaneDrag'), 'the workbench uses the drag session');
    assert.ok(wb.includes('dragSessionRef.current?.dispose()'), 'unmount disposes an in-flight drag');
    const compose = readFileSync(join(ROOT, 'public/dashboard2/src/turn-stream/render/fences/ComposeBlockFence.tsx'), 'utf8');
    const dataframe = readFileSync(join(ROOT, 'public/dashboard2/src/turn-stream/render/fences/DataframeFence.tsx'), 'utf8');
    assert.ok(compose.includes('copyWithFeedback'), 'compose copy surfaces a failure');
    assert.ok(dataframe.includes('copyWithFeedback') && dataframe.includes('role="alert"'), 'dataframe copy failure renders as an alert');
});
