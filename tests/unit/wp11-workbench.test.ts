// wp11 CF-4/CF-5/CF-6 — pane clamp, drag listener, copy exposure.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');

test('CF-4: the pane width is clamped by a central bounds helper used by state, drag, and ARIA', () => {
    const src = readFileSync(join(ROOT, 'public/dashboard2/src/shell/Workbench.tsx'), 'utf8');
    assert.ok(src.includes('paneBounds'), 'a central bounds helper exists');
    assert.ok(src.includes('clampPaneWidth'), 'a clamp helper exists');
    // ARIA uses the same bounds.
    assert.ok(src.includes('aria-valuemax={paneBounds().max}'), 'ARIA max comes from the bounds helper');
    assert.ok(src.includes('aria-valuemin={PANE_MIN}'), 'ARIA min is the pane min');
    // The initial width is clamped on open/resize so it cannot exceed the max.
    assert.ok(src.includes('clampPaneWidth(paneWidth)'), 'the state is clamped');
    // The drag uses the clamp, so it cannot dip below the min.
    assert.ok(src.includes('clampPaneWidth(rect.right - ev.clientX)'), 'the drag is clamped');
});

test('CF-5: mid-drag document listeners are released on unmount', () => {
    const src = readFileSync(join(ROOT, 'public/dashboard2/src/shell/Workbench.tsx'), 'utf8');
    assert.ok(src.includes('dragListenersRef'), 'drag listeners are tracked');
    assert.ok(src.includes('document.removeEventListener'), 'listeners are removed');
    // The unmount effect releases them.
    assert.match(src, /useEffect\(\(\) => \(\) => \{[\s\S]{0,300}removeEventListener/, 'an unmount cleanup releases the listeners');
});

test('CF-6: copy failures surface instead of being silent', () => {
    const compose = readFileSync(join(ROOT, 'public/dashboard2/src/turn-stream/render/fences/ComposeBlockFence.tsx'), 'utf8');
    const dataframe = readFileSync(join(ROOT, 'public/dashboard2/src/turn-stream/render/fences/DataframeFence.tsx'), 'utf8');
    assert.ok(compose.includes('.catch(') && compose.includes('Copy failed'), 'compose copy surfaces a failure');
    assert.ok(dataframe.includes('.catch(') && dataframe.includes('setCopyError'), 'dataframe copy surfaces a failure');
    assert.ok(dataframe.includes('role="alert"'), 'the failure renders as an alert');
});
