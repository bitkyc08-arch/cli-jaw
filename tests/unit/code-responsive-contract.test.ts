import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const css = readFileSync(join(root, 'public/manager/src/code/code.css'), 'utf8');

// Slice 217: Code mode must stay usable at narrow widths in both Manager shells.
// Previously code.css had NO @media query; header chips clipped and the sidebar
// kept a fixed 200px column.

test('code.css defines a narrow-width responsive breakpoint', () => {
    assert.ok(css.includes('@media (max-width: 720px)'), 'code.css must define a 720px breakpoint (matching the model popup precedent)');
});

test('narrow breakpoint wraps the header row and stacks the session sidebar', () => {
    const mq = css.slice(css.indexOf('@media (max-width: 720px)'));
    assert.ok(mq.includes('.code-workspace-primary') && mq.includes('flex-wrap: wrap'), 'header row must wrap instead of clipping at narrow width');
    assert.ok(mq.includes('.code-canvas') && mq.includes('flex-direction: column'), 'canvas must stack at narrow width');
    assert.ok(mq.includes('.code-canvas-sidebar') && mq.includes('width: 100%'), 'inline sidebar must go full-width when stacked');
});
