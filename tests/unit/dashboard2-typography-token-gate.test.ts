// 260726 wp12 S1 — component CSS may not hard-code a type size.
//
// dashboard2 declares 43 design tokens and then ignores them: 198 typographic
// literals are spread across 17 stylesheets, so the same "small label" is 10px
// in one file and 10.5px in another and nobody notices. A scale only holds if a
// gate keeps literals from creeping back.
//
// Two subtleties this gate has to respect, both learned the hard way:
//
//   1. `font:` shorthand also sets a size. Checking only `font-size:` would let
//      `font: 400 15px/24px var(--font-sans)` through — 12 such declarations
//      exist today.
//   2. `font: inherit` is NOT a literal. It is the standard reset that makes a
//      button inherit the page font, and there are 27 of them. Tokenising those
//      would break the inheritance contract they exist to establish.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const DASHBOARD2 = join(ROOT, 'public/dashboard2/src');

/** The canonical token file is where literals are *supposed* to live. */
const TOKEN_FILE = 'public/dashboard2/src/styles/tokens-v4.css';

function cssFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...cssFiles(full));
        else if (entry.endsWith('.css')) out.push(full);
    }
    return out;
}

/**
 * Every typographic size literal in a stylesheet.
 *
 * Whitespace is deliberately permissive (`font-size :12px` is legal CSS), and
 * the shorthand match requires a px value so `font: inherit` is left alone.
 */
function sizeLiterals(css: string): string[] {
    const found: string[] = [];
    for (const m of css.matchAll(/font-size\s*:\s*([0-9.]+)px/g)) found.push(`font-size: ${m[1]}px`);
    for (const m of css.matchAll(/(^|[;{\s])font\s*:\s*([^;}]*?[0-9.]+px[^;}]*)/g)) found.push(`font: ${m[2]!.trim()}`);
    return found;
}

test('component CSS carries no typographic size literal', () => {
    const offenders: string[] = [];

    for (const file of cssFiles(DASHBOARD2)) {
        const rel = relative(ROOT, file);
        if (rel === TOKEN_FILE) continue;
        const source = readFileSync(file, 'utf8');
        for (const literal of sizeLiterals(source)) {
            offenders.push(`${rel}: ${literal}`);
        }
    }

    assert.deepEqual(
        offenders,
        [],
        'a hard-coded type size drifts away from the scale the moment someone else edits nearby',
    );
});

test('the gate does not mistake `font: inherit` for a literal', () => {
    // A reset must survive the gate; otherwise the fix is to break inheritance.
    assert.deepEqual(sizeLiterals('button { font: inherit; }'), []);
    assert.deepEqual(sizeLiterals('a { font: inherit }'), []);
});

test('the gate catches shorthand sizes and spacing variants', () => {
    // Each of these shapes exists in dashboard2 today.
    assert.equal(sizeLiterals('p { font: 400 15px/24px var(--font-sans); }').length, 1);
    assert.equal(sizeLiterals('p { font: 500 11px var(--font-sans); }').length, 1);
    assert.equal(sizeLiterals('p { font: 12px/1.6 var(--font-mono); }').length, 1);
    assert.equal(sizeLiterals('p { font-size :12px }').length, 1);
    assert.equal(sizeLiterals('p { font-size:12.5px }').length, 1);
});

test('the gate ignores non-typographic px values', () => {
    assert.deepEqual(sizeLiterals('div { padding: 12px; height: 18px; }'), []);
    assert.deepEqual(sizeLiterals('div { line-height: 18px; }'), []);
});
