// 260726 wp13 — the QA harness has to survive its own maintenance.
//
// MEASURE_SOURCE is a template literal injected into the page. Twice while
// writing it I put a backtick inside a comment in that string, which silently
// terminated the template early: once it broke at import time, once it only
// broke inside page.evaluate, where the error was a bare "Invalid or unexpected
// token" with no hint about the cause. A gate suite that cannot load is worse
// than no gate suite, so this pins the shape of the source it injects.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const LIB = join(ROOT, 'scripts/qa/visual-lib.mjs');

function measureSource(): string {
    const file = readFileSync(LIB, 'utf8');
    const start = file.indexOf('String.raw`');
    assert.ok(start > 0, 'MEASURE_SOURCE must be a String.raw template');
    const end = file.indexOf('\n`;', start);
    assert.ok(end > start, 'MEASURE_SOURCE must be terminated');
    return file.slice(start + 'String.raw`'.length, end);
}

test('the injected measure source contains no backtick', () => {
    // A backtick anywhere inside ends the template, and the failure surfaces far
    // from the cause.
    const source = measureSource();
    const line = source.split('\n').findIndex((l) => l.includes('`'));
    assert.equal(line, -1, `line ${line + 1} of MEASURE_SOURCE contains a backtick`);
});

test('the injected measure source parses as a script', () => {
    const source = measureSource();
    assert.doesNotThrow(() => new Function(source), 'MEASURE_SOURCE must be valid JavaScript');
});

test('every helper the scanners call is exported onto the page object', () => {
    const source = measureSource();
    // Keep this list in step with what visual-scan.mjs actually uses; a helper
    // that is defined but never attached fails only at run time, in a browser.
    for (const name of [
        'parseColour', 'contrast', 'effectiveBackground', 'requiredContrast',
        'isVisible', 'textNodes', 'controls', 'describe',
        'targetAudit', 'accessibleName', 'occlusion', 'clippedOut',
    ]) {
        assert.match(source, new RegExp(`function ${name}\\b`), `${name} must be defined`);
        assert.match(source, new RegExp(`\\b${name}\\b[,\\s]*[,}]`), `${name} must be attached to __d2measure`);
    }
});

test('visibility accounts for scroll clipping, not just the viewport', () => {
    // 37 of 50 instance controls sit below the sidebar scrollport. Counting them
    // as visible made their neighbours look impossibly crowded and produced a
    // target-size "defect" that disappears once you scroll to it.
    const source = measureSource();
    assert.match(source, /clippedOut\(el\)\.clipped/, 'isVisible must consult clippedOut');
    assert.match(source, /overflowY|overflowX/, 'clipping ancestors must be found by overflow');
});

test('the spacing exception compares circles against real target areas', () => {
    // Centre-to-centre alone lets a wide neighbour pass while its edge sits
    // under the 24px circle.
    const source = measureSource();
    assert.match(source, /circle-vs-rect/, 'large neighbours need a circle/rectangle test');
    assert.match(source, /circle-vs-circle/, 'undersized neighbours need a circle/circle test');
});
