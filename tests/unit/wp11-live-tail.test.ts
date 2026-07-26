// wp11 CF-1 — the live tail's height growth participates in follow, and a
// user reading upward is not yanked back to the bottom.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
    AT_END_THRESHOLD_PX,
    LiveTailFollower,
} from '../../public/dashboard2/src/turn-stream/components/live-tail-follower.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');

const atEnd = { scrollHeight: 1000, scrollTop: 400, clientHeight: 600 };
const scrolledUp = { scrollHeight: 1000, scrollTop: 0, clientHeight: 600 };

test('a pinned user re-follows when the tail grows', () => {
    let follows = 0;
    const follower = new LiveTailFollower(100, () => { follows += 1; });
    follower.recordScroll(atEnd);
    follower.recordTailResize(150);
    assert.equal(follows, 1, 'tail growth while pinned re-pins the scrollport');
});

test('a user reading upward is not yanked back when the tail grows', () => {
    let follows = 0;
    const follower = new LiveTailFollower(100, () => { follows += 1; });
    follower.recordScroll(scrolledUp);
    follower.recordTailResize(150);
    assert.equal(follows, 0, 'no follow while scrolled up');
});

test('the pinned state is the state BEFORE the resize, not after', () => {
    let follows = 0;
    const follower = new LiveTailFollower(100, () => { follows += 1; });
    // The user is at the end; the tail then grows. The observer must use the
    // pre-resize snapshot — re-measuring after growth would see the already
    // -grown scrollHeight and always read "not at end".
    follower.recordScroll(atEnd);
    follower.recordTailResize(100 + 200);
    assert.equal(follows, 1, 'pre-resize pinned state drives the follow');
    // And a post-growth snapshot correctly reads as not-pinned for the NEXT resize.
    follower.recordScroll({ scrollHeight: 1200, scrollTop: 400, clientHeight: 600 });
    follower.recordTailResize(400);
    assert.equal(follows, 1, 'after the growth the same scrollTop is no longer at end');
});

test('the at-end threshold is a small pixel tolerance, not exact equality', () => {
    let follows = 0;
    const follower = new LiveTailFollower(100, () => { follows += 1; });
    follower.recordScroll({ scrollHeight: 1000, scrollTop: 400 - AT_END_THRESHOLD_PX, clientHeight: 600 });
    follower.recordTailResize(150);
    assert.equal(follows, 1, 'within the threshold counts as at end');
    follower.recordScroll({ scrollHeight: 1000, scrollTop: 400 - AT_END_THRESHOLD_PX - 1, clientHeight: 600 });
    follower.recordTailResize(200);
    assert.equal(follows, 1, 'one pixel beyond the threshold does not');
});

test('a same-height resize does not re-follow', () => {
    let follows = 0;
    const follower = new LiveTailFollower(100, () => { follows += 1; });
    follower.recordScroll(atEnd);
    follower.recordTailResize(100);
    assert.equal(follows, 0, 'no height change, no follow');
});

test('the viewport wires the follower to a ResizeObserver on the tail host', () => {
    const src = readFileSync(join(ROOT, 'public/dashboard2/src/turn-stream/components/TurnStreamViewport.tsx'), 'utf8');
    assert.ok(src.includes('LiveTailFollower'), 'the viewport uses the extracted follower');
    assert.ok(src.includes('ResizeObserver'), 'the tail height is observed');
    assert.ok(src.includes("scroll.addEventListener('scroll'"), 'the pinned state tracks scroll events');
});
