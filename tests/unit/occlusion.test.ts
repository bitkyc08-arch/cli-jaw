// A coordinate click dispatches wherever the point lands. If a cookie banner
// or modal covers the target, that element receives the click and the call
// still reports success - the most common silent failure in coordinate-based
// automation, because nothing in the response says the wrong thing was hit.
//
// The DOM walk needs a live browser. These cases pin the decision rules, which
// is where the judgement calls live: what counts as a cover, what counts as
// the same element, and what happens when the check cannot run at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeHit, HIT_TEST_SOURCE, type HitResult } from '../../src/browser/occlusion.ts';

const hit = (descriptor: string, ancestry: string[] = [], crossedFrame = false): HitResult =>
    ({ descriptor, ancestry, crossedFrame });

test('OCC-001: a banner over the target is a blocker', () => {
    const v = judgeHit(hit('div#consent-banner', ['body', 'html']), ['button']);
    assert.equal(v.blocked, true);
    assert.equal(v.blocked && v.blocker, 'div#consent-banner');
    assert.match(v.blocked ? v.reason : '', /covers the target/);
});

test('OCC-002: hitting the target itself is clear', () => {
    assert.equal(judgeHit(hit('button', ['div', 'body']), ['button']).blocked, false);
});

test('OCC-003: hitting a child of the target is clear', () => {
    // Clicking a button's inner span is clicking the button. Treating this as
    // a cover would refuse almost every real click.
    const v = judgeHit(hit('span.label', ['button', 'div', 'body']), ['button']);
    assert.equal(v.blocked, false);
    assert.equal(v.reason, 'clear');
});

test('OCC-004: hitting an ancestor of the target is clear', () => {
    const v = judgeHit(hit('div', ['body']), ['div', 'button']);
    assert.equal(v.blocked, false);
});

test('OCC-005: a label forwards rather than intercepts', () => {
    // A label sits over its control and delivers the click to it.
    assert.equal(judgeHit(hit('label', ['form', 'body']), ['input']).blocked, false);
});

test('OCC-006: a presentational wrapper is not a blocker', () => {
    assert.equal(judgeHit(hit('none', ['body']), ['button']).blocked, false);
    assert.equal(judgeHit(hit('presentation', ['body']), ['button']).blocked, false);
});

test('OCC-007: an unusable hit test fails OPEN', () => {
    // A cross-origin frame or a page that navigated mid-check. An
    // infrastructure failure must not block a legitimate click, and claiming
    // to know is worse than admitting we do not.
    const v = judgeHit(null, ['button']);
    assert.equal(v.blocked, false);
    assert.equal(v.reason, 'unknown');
});

test('OCC-008: with no expectation there is nothing to contradict', () => {
    // A pure coordinate click into canvas has no ref. "No evidence of a
    // problem" is not "evidence of no problem", so the verdict is unknown
    // rather than clear.
    const v = judgeHit(hit('canvas#board'), []);
    assert.equal(v.blocked, false);
    assert.equal(v.reason, 'unknown');
});

test('OCC-009: a point resolving into an iframe says so', () => {
    const v = judgeHit(hit('div#ad', ['body'], true), ['button']);
    assert.equal(v.blocked, true);
    assert.match(v.blocked ? v.reason : '', /resolves into an iframe/);
});

test('OCC-010: the blocker is named so the caller can act on it', () => {
    // "Something covered it" is not actionable. "div#consent-banner covered
    // it" tells an agent what to dismiss.
    const v = judgeHit(hit('div#cookie-wall', ['body']), ['a']);
    assert.equal(v.blocked && v.blocker, 'div#cookie-wall');
});

test('OCC-011: a class-suffixed descriptor still matches its tag rule', () => {
    // describe() emits tag#id or tag.class; the transparent-role check must
    // read the tag out of either shape.
    assert.equal(judgeHit(hit('label.field-label', ['form']), ['input']).blocked, false);
});

test('OCC-012: the injected source is a self-contained function expression', () => {
    // page.evaluate takes a function expression; a stray statement or a
    // reference to a module binding would throw inside the page.
    assert.match(HIT_TEST_SOURCE, /^\(point\) => \{/);
    assert.ok(HIT_TEST_SOURCE.trim().endsWith('}'));
    assert.doesNotMatch(HIT_TEST_SOURCE, /\bimport\b|\brequire\(/);
    // It must descend frames and report what it crossed.
    assert.match(HIT_TEST_SOURCE, /IFRAME/);
    assert.match(HIT_TEST_SOURCE, /crossedFrame/);
    // Shadow boundaries are walked through host, not just parentNode.
    assert.match(HIT_TEST_SOURCE, /getRootNode/);
});

test('OCC-013: ancestry is bounded so a deep tree cannot balloon the payload', () => {
    assert.match(HIT_TEST_SOURCE, /ancestry\.length < 24/);
});

