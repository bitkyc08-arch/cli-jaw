// The old extractor used /\{[^{}]*"found"...\}/. That class cannot cross a
// nested object, so a well-formed {found, bbox:{...}, point:{...}} response was
// unmatchable no matter what the model returned - the richer schema was
// unreachable by construction, not by choice.
//
// These tests attack the scanner rather than confirm it: braces inside strings,
// escaped quotes, unbalanced input, and the ordering that decides which object
// wins when a model emits several.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    extractJsonObjects,
    normalizeCandidate,
    parseCandidate,
    validateCandidate,
    isLowConfidence,
    LOW_CONFIDENCE_THRESHOLD,
} from '../../src/browser/grounding-candidate.ts';

test('GC-001: the nested shape the old regex could never match', () => {
    const text = '{"found":true,"bbox":{"x":10,"y":20,"width":30,"height":40},"point":{"x":25,"y":40},"confidence":0.9}';
    const c = parseCandidate(text);
    assert.ok(c, 'a nested object must parse');
    assert.equal(c.kind, 'grounding_bbox');
    assert.deepEqual(c.bbox, { x: 10, y: 20, width: 30, height: 40 });
    assert.deepEqual(c.point, { x: 25, y: 40 });
    assert.equal(c.confidence, 0.9);
    assert.deepEqual(c.riskFlags, []);
});

test('GC-002: braces inside strings do not open or close a span', () => {
    const text = '{"found":true,"x":5,"y":6,"description":"the { button } widget"}';
    const c = parseCandidate(text);
    assert.ok(c);
    assert.equal(c.description, 'the { button } widget');
    assert.deepEqual(c.point, { x: 5, y: 6 });
});

test('GC-003: escaped quotes do not end the string', () => {
    const text = String.raw`{"found":true,"x":1,"y":2,"description":"a \"quoted\" label"}`;
    const c = parseCandidate(text);
    assert.ok(c);
    assert.equal(c.description, 'a "quoted" label');
});

test('GC-004: an escaped backslash before a quote still terminates the string', () => {
    // "path\\" ends the string; a naive escape tracker reads it as an escaped
    // quote and swallows the rest of the object.
    const text = String.raw`{"found":true,"x":3,"y":4,"description":"path\\"}`;
    const c = parseCandidate(text);
    assert.ok(c, 'the object must still close');
    assert.deepEqual(c.point, { x: 3, y: 4 });
});

test('GC-005: prose and markdown fences around the answer are ignored', () => {
    const text = 'Let me look at the screenshot.\n\n\u0060\u0060\u0060json\n{"found":true,"x":7,"y":8}\n\u0060\u0060\u0060\nThat is the button.';
    const c = parseCandidate(text);
    assert.ok(c);
    assert.deepEqual(c.point, { x: 7, y: 8 });
});

test('GC-006: the LAST valid object wins', () => {
    // Models restate. The answer is what they said last, not first.
    const text = '{"found":false,"x":0,"y":0} then reconsidered {"found":true,"x":9,"y":9}';
    const c = parseCandidate(text);
    assert.ok(c);
    assert.equal(c.found, true);
    assert.deepEqual(c.point, { x: 9, y: 9 });
});

test('GC-007: key order does not matter', () => {
    const c = parseCandidate('{"y":2,"description":"d","x":1,"found":true}');
    assert.ok(c, 'the old regex required found -> x -> y in that order');
    assert.deepEqual(c.point, { x: 1, y: 2 });
});

test('GC-008: negative and fractional coordinates parse', () => {
    const c = parseCandidate('{"found":true,"x":-5,"y":12.5}');
    assert.ok(c, 'the old regex required \\d+ and rejected these');
    assert.deepEqual(c.point, { x: -5, y: 12.5 });
});

test('GC-009: unbalanced or truncated input yields nothing rather than throwing', () => {
    assert.equal(parseCandidate('{"found":true,"x":1'), null);
    assert.equal(parseCandidate('}}}{{{'), null);
    assert.equal(parseCandidate(''), null);
    assert.equal(parseCandidate('no json at all'), null);
    assert.deepEqual(extractJsonObjects('{"a":1'), []);
    assert.deepEqual(extractJsonObjects('}{'), []);
});

test('GC-010: a point-only answer is accepted but marked', () => {
    const c = parseCandidate('{"found":true,"x":4,"y":5}');
    assert.ok(c);
    assert.equal(c.kind, 'coordinate');
    assert.equal(c.bbox, null);
    assert.ok(c.riskFlags.includes('point_only'));
    assert.ok(isLowConfidence(c), 'a point-only answer must fail the gate');
});

test('GC-011: a bbox without a point derives its center', () => {
    const c = parseCandidate('{"found":true,"bbox":{"x":10,"y":10,"width":20,"height":40}}');
    assert.ok(c);
    assert.deepEqual(c.point, { x: 20, y: 30 });
    assert.equal(c.kind, 'grounding_bbox');
});

test('GC-012: a zero-area bbox is not a bbox', () => {
    // A box with no extent carries no information a point does not.
    const c = parseCandidate('{"found":true,"bbox":{"x":1,"y":1,"width":0,"height":5},"x":3,"y":4}');
    assert.ok(c);
    assert.equal(c.bbox, null);
    assert.equal(c.kind, 'coordinate');
    assert.ok(c.riskFlags.includes('point_only'));
});

test('GC-013: not-found carries a reason and never a coordinate', () => {
    const c = parseCandidate('{"found":false,"description":"no such control"}');
    assert.ok(c);
    assert.equal(c.kind, 'not_found');
    assert.equal(c.confidence, 0);
    assert.equal(c.reason, 'target_not_found');
});

test('GC-014: confidence is clamped, not trusted', () => {
    assert.equal(normalizeCandidate({ found: true, x: 1, y: 1, confidence: 5 })?.confidence, 1);
    assert.equal(normalizeCandidate({ found: true, x: 1, y: 1, confidence: -2 })?.confidence, 0);
    assert.equal(normalizeCandidate({ found: true, x: 1, y: 1, confidence: 'high' })?.confidence, 0.5);
    assert.equal(normalizeCandidate({ found: true, x: 1, y: 1, confidence: NaN })?.confidence, 0.5);
});

test('GC-015: malformed candidates are rejected', () => {
    assert.equal(normalizeCandidate(null), null);
    assert.equal(normalizeCandidate([]), null);
    assert.equal(normalizeCandidate({ x: 1, y: 1 }), null, 'found is required');
    assert.equal(normalizeCandidate({ found: 'yes', x: 1, y: 1 }), null, 'found must be boolean');
    assert.equal(normalizeCandidate({ found: true }), null, 'a found candidate needs a location');
    assert.equal(normalizeCandidate({ found: true, x: Infinity, y: 1 }), null);
});

test('GC-016: an out-of-bounds point is rejected before it can be clicked', () => {
    // The old path converted and clicked whatever came back.
    const c = parseCandidate('{"found":true,"x":99999,"y":99999}');
    assert.ok(c);
    const checked = validateCandidate(c, { width: 1280, height: 800 });
    assert.equal(checked.found, false);
    assert.equal(checked.kind, 'not_found');
    assert.ok(checked.riskFlags.includes('out_of_bounds'));
    assert.match(checked.reason ?? '', /outside the 1280x800 capture/);
});

test('GC-017: an in-bounds point passes through untouched', () => {
    const c = parseCandidate('{"found":true,"bbox":{"x":0,"y":0,"width":10,"height":10},"point":{"x":5,"y":5},"confidence":0.95}');
    assert.ok(c);
    assert.deepEqual(validateCandidate(c, { width: 1280, height: 800 }), c);
});

test('GC-018: the frame edges are inclusive', () => {
    const c = parseCandidate('{"found":true,"x":1280,"y":800}');
    assert.ok(c);
    assert.equal(validateCandidate(c, { width: 1280, height: 800 }).found, true);

    const over = parseCandidate('{"found":true,"x":1281,"y":800}');
    assert.ok(over);
    assert.equal(validateCandidate(over, { width: 1280, height: 800 }).found, false);
});

test('GC-019: a negative coordinate is out of bounds', () => {
    const c = parseCandidate('{"found":true,"x":-1,"y":10}');
    assert.ok(c);
    assert.equal(validateCandidate(c, { width: 1280, height: 800 }).found, false);
});

test('GC-020: validating a not-found candidate is a no-op', () => {
    const c = parseCandidate('{"found":false}');
    assert.ok(c);
    assert.deepEqual(validateCandidate(c, { width: 100, height: 100 }), c);
});

test('GC-021: the confidence gate is explicit about what it gates', () => {
    const strong = normalizeCandidate({ found: true, bbox: { x: 0, y: 0, width: 10, height: 10 }, confidence: 0.9 });
    assert.ok(strong && !isLowConfidence(strong));

    const weak = normalizeCandidate({ found: true, bbox: { x: 0, y: 0, width: 10, height: 10 }, confidence: 0.5 });
    assert.ok(weak && isLowConfidence(weak));

    // A confident point-only answer is still point-only.
    const confidentButBlind = normalizeCandidate({ found: true, x: 1, y: 1, confidence: 1 });
    assert.ok(confidentButBlind && isLowConfidence(confidentButBlind));

    assert.equal(LOW_CONFIDENCE_THRESHOLD, 0.75);
});

