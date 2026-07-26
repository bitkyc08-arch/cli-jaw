// wp11 CF-3 — a repeated history cursor is no-progress, not a loop.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { evaluateHistoryPageProgress } from '../../public/dashboard2/src/turn-stream/history/history-page-progress.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');

test('the first page (no previous cursor) is progress', () => {
    const { cursorAdvanced, noProgress } = evaluateHistoryPageProgress(null, 500);
    assert.equal(cursorAdvanced, true);
    assert.equal(noProgress, false);
});

test('a strictly decreasing cursor is progress (exclusive id < before)', () => {
    const { cursorAdvanced, noProgress } = evaluateHistoryPageProgress(500, 400);
    assert.equal(cursorAdvanced, true);
    assert.equal(noProgress, false);
});

test('a repeated cursor is no-progress — the loop must stop', () => {
    const { cursorAdvanced, noProgress } = evaluateHistoryPageProgress(500, 500);
    assert.equal(cursorAdvanced, false);
    assert.equal(noProgress, true, 'a same cursor marks exhausted, stopping loadOlder');
});

test('an increasing cursor is no-progress (the contract is violated)', () => {
    const { cursorAdvanced, noProgress } = evaluateHistoryPageProgress(500, 600);
    assert.equal(cursorAdvanced, false);
    assert.equal(noProgress, true);
});

test('a null next cursor after a real cursor is no-progress', () => {
    const { cursorAdvanced, noProgress } = evaluateHistoryPageProgress(500, null);
    assert.equal(cursorAdvanced, false);
    assert.equal(noProgress, true);
});

test('the controller marks exhausted on no-progress', () => {
    const src = readFileSync(join(ROOT, 'public/dashboard2/src/turn-stream/history/history-controller.ts'), 'utf8');
    assert.ok(src.includes('evaluateHistoryPageProgress'), 'the controller uses the extracted guard');
    assert.ok(src.includes('exhausted: exhausted || noProgress'), 'no-progress marks exhausted, stopping the loop');
});
