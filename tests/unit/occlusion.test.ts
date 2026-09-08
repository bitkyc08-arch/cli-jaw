// A coordinate click dispatches wherever the point lands. If a banner covers
// the target, that element receives the click and the call still reports
// success - the most common silent failure in coordinate automation.
//
// The previous version of this suite tested judgeHit against hand-built
// HitResult objects and asserted the injected source was a function
// EXPRESSION - which pinned the exact shape that made the whole check a
// permanent no-op, because Playwright evaluates a string without calling it.
// Eleven green tests over a mechanism that had never once executed.
//
// So these run the page function for real against a fake DOM. If it stops
// returning a usable HitResult, that fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeHit, hitTestInPage, type HitResult } from '../../src/browser/occlusion.ts';

// ─── judgement rules ───────────────────────────

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
    const v = judgeHit(hit('span.label', { relatesToTarget: true }));
    assert.equal(v.blocked, false);
    assert.equal(v.reason, 'clear');
});

test('OCC-003: an unusable hit test fails OPEN', () => {
    // An infrastructure failure must not block a legitimate click, and
    // claiming to know is worse than admitting we do not.
    const v = judgeHit(null);
    assert.equal(v.blocked, false);
    assert.equal(v.reason, 'unknown');
});

test('OCC-004: with no marked target the verdict is unknown, not clear', () => {
    // "No evidence of a problem" is not "evidence of no problem". Collapsing
    // the two would let an unchecked click report as a verified one.
    const v = judgeHit(hit('canvas#board'));
    assert.equal(v.blocked, false);
    assert.equal(v.reason, 'unknown');
});

test('OCC-005: identity is not a name-matching problem', () => {
    // An earlier version compared the ref's ARIA role against the hit's DOM
    // tag: a 'link' is an 'a', a 'textbox' is an 'input', a 'button' is often
    // a 'div'. All three compared unequal and blocked a working click.
    assert.equal(judgeHit(hit('a.nav', { relatesToTarget: true })).blocked, false);
    assert.equal(judgeHit(hit('input#q', { relatesToTarget: true })).blocked, false);
    assert.equal(judgeHit(hit('div.btn', { relatesToTarget: true })).blocked, false);
});

test('OCC-006: a point resolving into an iframe says so', () => {
    const v = judgeHit(hit('div#ad', { crossedFrame: true, relatesToTarget: false }));
    assert.equal(v.blocked, true);
    assert.match(v.blocked ? v.reason : '', /resolves into an iframe/);
});

// ─── the page function, actually executed ──────

type FakeEl = Record<string, unknown>;

function el(tag: string, props: Record<string, unknown> = {}): FakeEl {
    const node: FakeEl = { tagName: tag.toUpperCase(), clientLeft: 0, clientTop: 0, ...props };
    node['getBoundingClientRect'] = () => ({ left: 0, top: 0 });
    node['closest'] = () => null;
    node['contains'] = (n: unknown) => n === node;
    return node;
}

/** Install a minimal document whose elementFromPoint answers from a map. */
function withDocument(at: (x: number, y: number) => FakeEl | null, run: () => void): void {
    const original = (globalThis as Record<string, unknown>)['document'];
    (globalThis as Record<string, unknown>)['document'] = {
        elementFromPoint: (x: number, y: number) => at(x, y),
    };
    try { run(); } finally { (globalThis as Record<string, unknown>)['document'] = original; }
}

test('OCC-007: the page function RUNS and returns a usable result', () => {
    // The whole point of this file. A string form would have returned
    // undefined here, silently.
    withDocument(() => el('button', { id: 'go' }), () => {
        const r = hitTestInPage({ x: 10, y: 10 });
        assert.ok(r, 'the hit test must return something');
        assert.equal(r.descriptor, 'button#go');
        assert.equal(r.crossedFrame, false);
        assert.equal(r.relatesToTarget, undefined, 'no target was marked');
    });
});

test('OCC-008: an element covering the target is reported as unrelated', () => {
    const banner = el('div', { id: 'consent-banner' });
    const button = el('button');
    withDocument((x) => (x === 10 ? banner : button), () => {
        const r = hitTestInPage({ x: 10, y: 10, targetPoint: { x: 50, y: 50 } });
        assert.ok(r);
        assert.equal(r.descriptor, 'div#consent-banner');
        assert.equal(r.relatesToTarget, false);
        const v = judgeHit(r);
        assert.equal(v.blocked, true, 'and the verdict must actually block');
        assert.equal(v.blocked && v.blocker, 'div#consent-banner');
    });
});

test('OCC-009: hitting a child of the target is related', () => {
    const button = el('button');
    const span = el('span', { className: 'label', parentNode: button });
    withDocument((x) => (x === 10 ? span : button), () => {
        const r = hitTestInPage({ x: 10, y: 10, targetPoint: { x: 50, y: 50 } });
        assert.ok(r);
        assert.equal(r.relatesToTarget, true, 'clicking a button\u2019s inner span is clicking the button');
        assert.deepEqual(r.ancestry, ['button']);
        assert.equal(judgeHit(r).blocked, false);
    });
});

test('OCC-010: a shadow boundary is crossed through host', () => {
    const host = el('my-widget');
    const inner = el('button', { getRootNode: () => ({ host }) });
    withDocument((x) => (x === 10 ? inner : host), () => {
        const r = hitTestInPage({ x: 10, y: 10, targetPoint: { x: 50, y: 50 } });
        assert.ok(r);
        assert.equal(r.relatesToTarget, true, 'the host chain must be walked');
    });
});

test('OCC-011: a null hit yields null rather than throwing', () => {
    withDocument(() => null, () => {
        assert.equal(hitTestInPage({ x: 1, y: 1 }), null);
    });
});

test('OCC-012: a cyclic parent chain cannot hang the walk', () => {
    const a = el('div', { id: 'a' });
    const b = el('div', { id: 'b', parentNode: a });
    a['parentNode'] = b; // cycle
    withDocument(() => b, () => {
        const r = hitTestInPage({ x: 1, y: 1 });
        assert.ok(r);
        assert.ok(r.ancestry.length <= 24, 'ancestry must stay bounded');
    });
});

test('OCC-013: an unreadable frame stops the descent instead of looping', () => {
    const frame = el('iframe', { id: 'ad', contentDocument: null });
    withDocument(() => frame, () => {
        const r = hitTestInPage({ x: 1, y: 1, targetPoint: { x: 1, y: 1 } });
        assert.ok(r);
        assert.equal(r.descriptor, 'iframe#ad');
        // The frame was hit-tested as the target too, so it relates to itself.
        assert.equal(r.relatesToTarget, true);
    });
});

test('OCC-014: a cross-origin frame is unknown, not a blocker', () => {
    // The element behind an opaque frame is unknowable from here, so the frame
    // itself is reported as the hit — which looks exactly like a cover. The
    // target may well be inside it, and refusing on that evidence would block
    // legitimate clicks into every cross-origin embed.
    const frame = el('iframe', { id: 'embed', contentDocument: null });
    const button = el('button');
    withDocument((x) => (x === 10 ? frame : button), () => {
        const r = hitTestInPage({ x: 10, y: 10, targetPoint: { x: 50, y: 50 } });
        assert.ok(r);
        assert.equal(r.opaqueFrame, true, 'the walk must record that it could not see in');
        assert.equal(r.relatesToTarget, false, 'and the frame is not the target');

        const v = judgeHit(r);
        assert.equal(v.blocked, false, 'but an unknowable interior must not block');
        assert.equal(v.reason, 'unknown');
    });
});

test('OCC-015: a readable frame is still judged normally', () => {
    // The opaque-frame escape must not become a blanket exemption for frames.
    const inner = el('div', { id: 'overlay' });
    const child = { elementFromPoint: () => inner } as unknown as Document;
    const frame = el('iframe', { id: 'ok', contentDocument: child });
    const button = el('button');
    withDocument((x) => (x === 10 ? frame : button), () => {
        const r = hitTestInPage({ x: 10, y: 10, targetPoint: { x: 50, y: 50 } });
        assert.ok(r);
        assert.equal(r.opaqueFrame, undefined);
        assert.equal(r.crossedFrame, true);
        assert.equal(judgeHit(r).blocked, true, 'a visible cover inside a frame still blocks');
    });
});
