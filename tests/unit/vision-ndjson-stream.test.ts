// The audit that reshaped this work made one point that outlived every
// individual fix: the tests exercised the pure modules while all three bounds
// bypasses lived in the seam between them - codexVision's NDJSON loop and
// visionClick's frame derivation.
//
// This file covers that seam's parsing half directly, using the real event
// shapes codex emits, so a regression there fails here rather than in
// production. The dispatch half needs a live browser and belongs with the
// verification work later in this stack.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCandidate } from '../../src/browser/grounding-candidate.ts';

/** The prompt codexVision sends carries a literal not-found template. */
const PROMPT_ECHO = 'If not found: {"found":false,"x":0,"y":0,"description":"not found"}';

/** Mirror of collectEventTexts: item.text, then item.aggregated_output. */
function collectEventTexts(event: unknown): string[] {
    const e = event as { item?: { text?: unknown; aggregated_output?: unknown } };
    if (!e || typeof e !== 'object' || !e.item) return [];
    return [e.item.text, e.item.aggregated_output].filter((t): t is string => typeof t === 'string');
}

/** Mirror of the scan in codexVision: newest event first. */
function resolveFromStream(ndjson: string) {
    const lines = ndjson.split('\n').filter(l => l.trim());
    for (const line of [...lines].reverse()) {
        let event: unknown;
        try { event = JSON.parse(line); } catch { continue; }
        for (const text of collectEventTexts(event)) {
            const candidate = parseCandidate(text);
            if (candidate) return candidate;
        }
    }
    return null;
}

function agentMessage(text: string): string {
    return JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } });
}

test('VNS-001: a plain coordinate answer resolves from the stream', () => {
    const stream = [
        JSON.stringify({ type: 'thread.started', thread_id: 'x' }),
        JSON.stringify({ type: 'turn.started' }),
        agentMessage('{"found":true,"x":120,"y":340,"description":"submit button"}'),
        JSON.stringify({ type: 'turn.completed' }),
    ].join('\n');
    const c = resolveFromStream(stream);
    assert.ok(c);
    assert.deepEqual(c.point, { x: 120, y: 340 });
});

test('VNS-002: an echo of the prompt template does not erase the answer', () => {
    // This is the regression that motivated preferring a located answer: the
    // model restates its instructions after answering.
    const stream = [
        agentMessage(`Found it. {"found":true,"x":40,"y":50} (${PROMPT_ECHO})`),
        JSON.stringify({ type: 'turn.completed' }),
    ].join('\n');
    const c = resolveFromStream(stream);
    assert.ok(c);
    assert.equal(c.found, true, 'a trailing template must not win');
    assert.deepEqual(c.point, { x: 40, y: 50 });
});

test('VNS-003: a later real answer supersedes an earlier one', () => {
    const stream = [
        agentMessage('{"found":true,"x":1,"y":1}'),
        agentMessage('On closer look: {"found":true,"x":700,"y":220}'),
    ].join('\n');
    const c = resolveFromStream(stream);
    assert.ok(c);
    assert.deepEqual(c.point, { x: 700, y: 220 }, 'the newest event wins');
});

test('VNS-004: a genuine not-found survives the stream', () => {
    const stream = [agentMessage('I searched. {"found":false,"description":"no such control"}')].join('\n');
    const c = resolveFromStream(stream);
    assert.ok(c);
    assert.equal(c.found, false);
});

test('VNS-005: command output quoting page text does not hide the answer', () => {
    // aggregated_output carries arbitrary text, including unbalanced quotes.
    const stream = [
        JSON.stringify({
            type: 'item.completed',
            item: { type: 'command_execution', aggregated_output: 'label: the 15" monitor' },
        }),
        agentMessage('{"found":true,"x":88,"y":99}'),
    ].join('\n');
    const c = resolveFromStream(stream);
    assert.ok(c);
    assert.deepEqual(c.point, { x: 88, y: 99 });
});

test('VNS-006: an answer wrapped by the model is still recovered', () => {
    const stream = [agentMessage('{"result":{"found":true,"x":11,"y":22}}')].join('\n');
    const c = resolveFromStream(stream);
    assert.ok(c, 'a wrapper object must not hide the answer');
    assert.deepEqual(c.point, { x: 11, y: 22 });
});

test('VNS-007: non-JSON lines and empty events are skipped, not fatal', () => {
    const stream = [
        'not json at all',
        '',
        JSON.stringify({ type: 'turn.started' }),
        JSON.stringify({ type: 'item.completed', item: { type: 'reasoning' } }),
        agentMessage('{"found":true,"x":3,"y":4}'),
    ].join('\n');
    const c = resolveFromStream(stream);
    assert.ok(c);
    assert.deepEqual(c.point, { x: 3, y: 4 });
});

test('VNS-008: a stream with no answer resolves to nothing', () => {
    const stream = [
        JSON.stringify({ type: 'thread.started' }),
        agentMessage('I could not analyze the image.'),
    ].join('\n');
    assert.equal(resolveFromStream(stream), null);
});

test('VNS-009: an implausible coordinate never leaves the stream', () => {
    const stream = [agentMessage('{"found":true,"x":1e12,"y":1e12}')].join('\n');
    assert.equal(resolveFromStream(stream), null, 'normalization must reject it before dispatch');
});

