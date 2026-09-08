// A coordinate click dispatches wherever the point lands. If a cookie banner
// or modal covers the target, that element receives the click and the call
// still reports success - the most common silent failure in coordinate
// automation, because nothing in the response says the wrong thing was hit.
//
// The DOM walk needs a live browser. These cases pin the decision rules and
// the shape of the injected source, which is where the judgement calls live.
import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeHit, HIT_TEST_SOURCE, type HitResult } from '../../src/browser/occlusion.ts';

const hit = (
    descriptor: string,
    opts: { ancestry?: string[]; crossedFrame?: boolean; relatesToTarget?: boolean } = {},
): HitResult => ({
    descriptor,
    ancestry: opts.ancestry ?? [],
    crossedFrame: opts.crossedFrame ?? false,
    ...(opts.relatesToTarget === undefined ? {} : { relatesToTarget: opts.relatesToTarget }),
});

test('OCC-001: an unrelated element over the target is a blocker', () => {
    const v = judgeHit(hit('div#consent-banner', { relatesToTarget: false }));
    assert.equal(v.blocked, true);
    assert.equal(v.blocked && v.blocker, 'div#consent-banner');
    assert.match(v.blocked ? v.reason : '', /covers the target/);
});

test('OCC-002: an element related to the target is clear', () => {
    // The page decides this against the real node: the hit is the target,
    // inside it, or contains it. Clicking a button's inner span is clicking
    // the button.
    const v = judgeHit(hit('span.label', { relatesToTarget: true }));
    assert.equal(v.blocked, false);
    assert.equal(v.reason, 'clear');
});

test('OCC-003: an unusable hit test fails OPEN', () => {
    // A cross-origin frame or a page that navigated mid-check. An
    // infrastructure failure must not block a legitimate click, and claiming
    // to know is worse than admitting we do not.
    const v = judgeHit(null);
    assert.equal(v.blocked, false);
    assert.equal(v.reason, 'unknown');
});

test('OCC-004: with no marked target the verdict is unknown, not clear', () => {
    // A pure coordinate click into canvas has no reconciled ref. "No evidence
    // of a problem" is not "evidence of no problem", and collapsing the two
    // would let an unchecked click report as a verified one.
    const v = judgeHit(hit('canvas#board'));
    assert.equal(v.blocked, false);
    assert.equal(v.reason, 'unknown');
});

test('OCC-005: identity is not a name-matching problem', () => {
    // An earlier version compared the reconciled ref's ARIA role against the
    // hit's DOM tag. A 'link' is an 'a', a 'textbox' is an 'input', and a
    // 'button' is often a 'div' - every one of those compared unequal and
    // blocked a click that would have worked. The page now answers with
    // identity, so the descriptor's spelling is irrelevant to the verdict.
    assert.equal(judgeHit(hit('a.nav', { relatesToTarget: true })).blocked, false);
    assert.equal(judgeHit(hit('input#q', { relatesToTarget: true })).blocked, false);
    assert.equal(judgeHit(hit('div.btn', { relatesToTarget: true })).blocked, false);
});

test('OCC-006: a point resolving into an iframe says so', () => {
    const v = judgeHit(hit('div#ad', { crossedFrame: true, relatesToTarget: false }));
    assert.equal(v.blocked, true);
    assert.match(v.blocked ? v.reason : '', /resolves into an iframe/);
});

test('OCC-007: the blocker is named so the caller can act on it', () => {
    // "Something covered it" is not actionable. "div#cookie-wall covered it"
    // tells an agent what to dismiss.
    const v = judgeHit(hit('div#cookie-wall', { relatesToTarget: false }));
    assert.equal(v.blocked && v.blocker, 'div#cookie-wall');
});

test('OCC-008: the injected source is a self-contained function expression', () => {
    // page.evaluate takes a function expression; a module reference would
    // throw inside the page rather than at build time.
    assert.match(HIT_TEST_SOURCE, /^\(arg\) => \{/);
    assert.ok(HIT_TEST_SOURCE.trim().endsWith('}'));
    assert.doesNotMatch(HIT_TEST_SOURCE, /\bimport\b|\brequire\(/);
});

test('OCC-009: the page-side walk crosses frames and shadow boundaries', () => {
    assert.match(HIT_TEST_SOURCE, /IFRAME/);
    assert.match(HIT_TEST_SOURCE, /crossedFrame/);
    // Shadow roots are traversed through host, not only parentNode.
    assert.match(HIT_TEST_SOURCE, /getRootNode/);
    // The child frame's own viewport origin and border are subtracted.
    assert.match(HIT_TEST_SOURCE, /rect\.left \+ hit\.clientLeft/);
    assert.match(HIT_TEST_SOURCE, /rect\.top \+ hit\.clientTop/);
});

test('OCC-010: every page-side walk is bounded', () => {
    // A cyclic frame or a pathological tree must not hang the page.
    assert.match(HIT_TEST_SOURCE, /depth < 16/);
    assert.match(HIT_TEST_SOURCE, /guard < 24/);
    assert.match(HIT_TEST_SOURCE, /guard < 200/);
});

test('OCC-011: relatedness is resolved from a point on the target', () => {
    // Not from a selector: an ARIA ref cannot be turned into one reliably.
    assert.match(HIT_TEST_SOURCE, /arg\.targetPoint/);
    assert.match(HIT_TEST_SOURCE, /elementFromPoint\(arg\.targetPoint\.x/);
    // A label forwarding to the target counts as related.
    assert.match(HIT_TEST_SOURCE, /lbl\.control === target/);
});

