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
