import test from 'node:test';
import assert from 'node:assert/strict';

import { streamJsonMarksProgress } from '../../src/agent/events/helpers.ts';

// A parsed stream-json line is a runtime saying it is still working. cursor was
// not on this list, so its turns leaned on the watchdog's "more than ten bytes
// came out" heuristic — the same signal a progress bar produces. A real 933s
// turn died with lastProgress=output x302 (#405).
//
// The call site in spawn.ts is inside a 3000-line function with no injection
// point, so this covers the judgment rather than the wiring; the wiring is
// checked on a live host (see the plan's verification section).
test('CP-001: cursor stream-json counts as structured progress', () => {
    assert.equal(streamJsonMarksProgress('cursor'), true);
});

test('CP-002: the runtimes that already counted still count', () => {
    assert.equal(streamJsonMarksProgress('grok'), true);
    assert.equal(streamJsonMarksProgress('ai-e', 'grok'), true);
});

test('CP-003: nothing else was widened', () => {
    // ai-e is provider-dependent: only its grok provider emits the stream-json
    // this reads as progress.
    assert.equal(streamJsonMarksProgress('ai-e', 'anthropic'), false);
    assert.equal(streamJsonMarksProgress('ai-e'), false);
    assert.equal(streamJsonMarksProgress('codex'), false);
    assert.equal(streamJsonMarksProgress('claude'), false);
    assert.equal(streamJsonMarksProgress('opencode'), false);
});

// What this change does and does not buy, measured rather than asserted in prose.
//
// A stream-json line is longer than ten characters, so `observe()` already
// called markProgress('output') for it and pushed the deadline by the same
// absoluteMs. Marking it structured does not buy TIME — it buys a stall report
// that distinguishes "the runtime was still working" from "bytes were
// appearing", which is the difference the 933s incident turned on.
test('CP-004: structured and output progress buy the same deadline, not the same story', async () => {
    const { attachWatchdog } = await import('../../src/agent/watchdog.ts');
    const { PassThrough } = await import('node:stream');

    const run = (mark: 'structured' | 'output') => new Promise<{ reason: string; elapsed: number }>((resolve) => {
        const child = { stdout: new PassThrough(), stderr: new PassThrough() } as never;
        const startedAt = Date.now();
        const handle = attachWatchdog(child, 'test', (reason: string) => {
            handle.stop();
            resolve({ reason, elapsed: Date.now() - startedAt });
        }, { firstProgressMs: 1_000, idleMs: 1_000, absoluteMs: 60, absoluteHardCapMs: 600, checkIntervalMs: 5 });
        if (mark === 'structured') handle.markProgress();
        else (child as { stdout: InstanceType<typeof PassThrough> }).stdout
            .emit('data', Buffer.from('a stream-json line, well over ten characters\n'));
    });

    const [structured, output] = await Promise.all([run('structured'), run('output')]);

    // Same deadline: one mark, one absoluteMs extension, either way.
    assert.ok(
        Math.abs(structured.elapsed - output.elapsed) < 40,
        `marking does not change WHEN it dies: ${structured.elapsed} vs ${output.elapsed}`,
    );
    // Different story, which is the whole point.
    assert.match(structured.reason, /lastProgress=structured/);
    assert.match(output.reason, /lastProgress=output/);
});
