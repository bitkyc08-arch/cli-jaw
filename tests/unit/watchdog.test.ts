import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

import { attachWatchdog, type WatchdogHandle } from '../../src/agent/watchdog.ts';

function fakeChild(): ChildProcess {
    return {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
    } as unknown as ChildProcess;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForStall(
    handleRef: { handle?: WatchdogHandle },
    config: Parameters<typeof attachWatchdog>[3],
): Promise<string> {
    return new Promise((resolve) => {
        const child = fakeChild();
        handleRef.handle = attachWatchdog(child, 'test', resolve, config);
    });
}

test('active progress extends absolute deadline past original absoluteMs', async () => {
    const child = fakeChild();
    let handle: WatchdogHandle | undefined;
    let stalled = false;
    const progress = setInterval(() => {
        child.stdout?.emit('data', Buffer.from('ordinary progress output\n'));
    }, 5);
    try {
        const stallPromise = new Promise<string>((resolve) => {
            handle = attachWatchdog(child, 'test', resolve, {
                firstProgressMs: 1_000,
                idleMs: 1_000,
                absoluteMs: 30,
                absoluteHardCapMs: 200,
                checkIntervalMs: 5,
            });
        }).then(reason => { stalled = true; return reason; });

        await sleep(80);
        assert.equal(stalled, false, 'active progress should extend deadline past original absoluteMs');

        const reason = await stallPromise;
        assert.match(reason, /absolute timeout/);
    } finally {
        clearInterval(progress);
        handle?.stop();
    }
});

test('absolute timeout fires without any progress', async () => {
    const handleRef: { handle?: WatchdogHandle } = {};
    const reason = await waitForStall(handleRef, {
        firstProgressMs: 1_000,
        idleMs: 1_000,
        absoluteMs: 30,
        checkIntervalMs: 5,
    });
    assert.match(reason, /absolute timeout/);
});

test('extendDeadline delays absolute timeout', async () => {
    const handleRef: { handle?: WatchdogHandle } = {};
    let stalled = false;
    const stallPromise = waitForStall(handleRef, {
        firstProgressMs: 1_000,
        idleMs: 1_000,
        absoluteMs: 30,
        absoluteHardCapMs: 300,
        checkIntervalMs: 5,
    }).then((reason) => {
        stalled = true;
        return reason;
    });

    await sleep(10);
    handleRef.handle?.extendDeadline(120, 'test extension');
    await sleep(65);
    assert.equal(stalled, false, 'deadline should be extended beyond the original absolute timeout');

    const reason = await stallPromise;
    assert.match(reason, /absolute timeout/);
});

test('extendDeadline is monotonic and does not shorten deadline', async () => {
    const handleRef: { handle?: WatchdogHandle } = {};
    let stalled = false;
    const stallPromise = waitForStall(handleRef, {
        firstProgressMs: 1_000,
        idleMs: 1_000,
        absoluteMs: 40,
        absoluteHardCapMs: 300,
        checkIntervalMs: 5,
    }).then((reason) => {
        stalled = true;
        return reason;
    });

    await sleep(10);
    handleRef.handle?.extendDeadline(160, 'long extension');
    await sleep(10);
    handleRef.handle?.extendDeadline(20, 'shorter ignored extension');
    await sleep(90);
    assert.equal(stalled, false, 'shorter extension should not shrink the deadline');

    const reason = await stallPromise;
    assert.match(reason, /absolute timeout/);
});

test('extendDeadline respects absolute hard cap', async () => {
    const startedAt = Date.now();
    const handleRef: { handle?: WatchdogHandle } = {};
    const stallPromise = waitForStall(handleRef, {
        firstProgressMs: 1_000,
        idleMs: 1_000,
        absoluteMs: 30,
        absoluteHardCapMs: 80,
        checkIntervalMs: 5,
    });

    await sleep(10);
    handleRef.handle?.extendDeadline(1_000, 'capped extension');
    const reason = await stallPromise;
    const elapsed = Date.now() - startedAt;

    assert.match(reason, /absolute timeout/);
    assert.ok(elapsed < 250, `expected hard cap to bound timeout, elapsed=${elapsed}`);
});

test('markProgress clamps to hard cap instead of skipping extension', async () => {
    const child = fakeChild();
    let handle: WatchdogHandle | undefined;
    const startedAt = Date.now();
    const stallPromise = new Promise<string>((resolve) => {
        handle = attachWatchdog(child, 'test', resolve, {
            firstProgressMs: 1_000,
            idleMs: 1_000,
            absoluteMs: 60,
            absoluteHardCapMs: 90,
            checkIntervalMs: 5,
        });
    });

    await sleep(50);
    child.stdout?.emit('data', Buffer.from('progress near hard cap boundary\n'));
    await sleep(20);
    child.stdout?.emit('data', Buffer.from('more progress past hard cap\n'));

    const reason = await stallPromise;
    const elapsed = Date.now() - startedAt;
    assert.match(reason, /absolute timeout/);
    assert.ok(elapsed >= 85, `should extend to hard cap, not skip; elapsed=${elapsed}`);
    assert.ok(elapsed < 200, `should not exceed hard cap; elapsed=${elapsed}`);
    handle?.stop();
});

test('Claude rate_limit_event JSON counts as progress even when it contains 429 text', async () => {
    const child = fakeChild();
    let stalled = false;
    const handle = attachWatchdog(child, 'test', () => {
        stalled = true;
    }, {
        firstProgressMs: 20,
        idleMs: 20,
        absoluteMs: 120,
        absoluteHardCapMs: 200,
        checkIntervalMs: 5,
    });

    child.stdout?.emit('data', Buffer.from('{"type":"rate_limit_event","message":"429 Too Many Requests"}\n'));
    await sleep(35);
    assert.equal(stalled, false, 'rate_limit_event should mark progress before matching retry text');
    handle.stop();
});

test('generic watchdog does not treat punctuation-only tiny chunks as progress', async () => {
    const child = fakeChild();
    const startedAt = Date.now();
    const stallPromise = new Promise<string>((resolve) => {
        attachWatchdog(child, 'test', resolve, {
            firstProgressMs: 1_000,
            idleMs: 1_000,
            absoluteMs: 45,
            absoluteHardCapMs: 200,
            checkIntervalMs: 5,
        });
    });

    const progress = setInterval(() => {
        child.stdout?.emit('data', Buffer.from('.'));
    }, 5);
    const reason = await stallPromise;
    clearInterval(progress);
    const elapsed = Date.now() - startedAt;

    assert.match(reason, /absolute timeout/);
    assert.ok(elapsed < 120, `tiny chunks should not extend generic watchdog deadline; elapsed=${elapsed}`);
});

test('stop prevents future stall callbacks', async () => {
    const child = fakeChild();
    let called = false;
    const handle = attachWatchdog(child, 'test', () => {
        called = true;
    }, {
        firstProgressMs: 20,
        idleMs: 20,
        absoluteMs: 20,
        checkIntervalMs: 5,
    });

    handle.stop();
    await sleep(60);
    assert.equal(called, false);
});

// ─── what the stall report says was keeping the turn alive (#405) ───
//
// The stall reason string is the only observable difference between "the
// runtime kept telling us it was working" and "bytes kept appearing". It is
// what the 933s incident was diagnosed from, so it is what these assert:
// `outputOnlyProgress` is a local inside the watchdog and cannot be read.

test('WDP-001: an unqualified markProgress() reports as structured', async () => {
    const child = fakeChild();
    let handle: WatchdogHandle | undefined;
    const reason = await new Promise<string>((resolve) => {
        handle = attachWatchdog(child, 'test', resolve, {
            firstProgressMs: 1_000, idleMs: 1_000,
            absoluteMs: 40, absoluteHardCapMs: 400, checkIntervalMs: 5,
        });
        // No argument, exactly as the stream-json path calls it.
        handle.markProgress();
    });
    handle?.stop();

    assert.match(reason, /lastProgress=structured/);
    assert.doesNotMatch(reason, /x\d/, 'structured progress is not counted as repeated weak output');
});

test('WDP-002: raw output reports as output, and repeats are counted', async () => {
    const child = fakeChild();
    let handle: WatchdogHandle | undefined;
    const stallPromise = new Promise<string>((resolve) => {
        handle = attachWatchdog(child, 'test', resolve, {
            firstProgressMs: 1_000, idleMs: 1_000,
            absoluteMs: 40, absoluteHardCapMs: 400, checkIntervalMs: 5,
        });
    });
    // Over ten characters, or observe() ignores it.
    for (let i = 0; i < 3; i++) child.stdout?.emit('data', Buffer.from('ordinary output line\n'));
    const reason = await stallPromise;
    handle?.stop();

    // This is the shape the incident produced: output x302, never structured.
    assert.match(reason, /lastProgress=output x3/);
});

test('WDP-003: structured progress pushes the deadline, and stops pushing when it stops', async () => {
    const child = fakeChild();
    let handle: WatchdogHandle | undefined;
    let stalled = false;
    const stallPromise = new Promise<string>((resolve) => {
        handle = attachWatchdog(child, 'test', resolve, {
            firstProgressMs: 1_000, idleMs: 1_000,
            absoluteMs: 40, absoluteHardCapMs: 1_000, checkIntervalMs: 5,
        });
    }).then(reason => { stalled = true; return reason; });

    const ticking = setInterval(() => handle?.markProgress(), 10);
    await sleep(120);
    assert.equal(stalled, false, 'a runtime still reporting progress must not be killed at absoluteMs');

    clearInterval(ticking);
    const reason = await stallPromise;
    handle?.stop();
    assert.match(reason, /absolute timeout/, 'once progress stops, the deadline applies again');
});
