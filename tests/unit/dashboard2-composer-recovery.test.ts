// 260725 wp4 — failure paths in the composer and pending queue.
//
// Neither of these strands the user permanently, but both leave them acting on
// a false picture: a microphone that is still live after an error, and a steer
// that silently lost its hold on the queue.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

test('a recorder that fails mid-recording does not leave the UI recording', () => {
    const recorder = read('public/dashboard2/src/chat/composer/useVoiceRecorder.ts');

    // Without onerror the recorder goes inactive while React still says
    // 'recording'. Stop() on an inactive recorder is a no-op, so the button
    // does nothing and the mic stays held.
    assert.match(recorder, /recorder\.onerror\s*=/, 'an asynchronous recorder failure must be handled');
    const handler = recorder.match(/recorder\.onerror = \(\) => \{[\s\S]{0,500}?\n            \};/)?.[0] ?? '';
    assert.ok(handler, 'the handler must have a body');
    assert.match(handler, /stopStream/, 'and must release the microphone');
    assert.match(handler, /setState\('error'\)/, 'and must leave a state the user can recover from');
});

test('a stream acquired before a recorder failure is released immediately', () => {
    const recorder = read('public/dashboard2/src/chat/composer/useVoiceRecorder.ts');
    const startCatch = recorder.match(/\} catch \(cause\) \{[\s\S]{0,800}?setState\('error'\);/)?.[0] ?? '';

    assert.ok(startCatch, 'the start path must have a catch');
    // getUserMedia can succeed and then `new MediaRecorder` or start() throws;
    // the mic would stay live until the user dismissed the error.
    assert.match(startCatch, /stopStream\(streamRef\.current\)/, 'a half-acquired stream must be released, not held until dismissal');
});

test('a failed queue hold tells the user instead of arming silently', () => {
    const machine = read('public/dashboard2/src/chat/pending/pending-queue-machine.ts');
    const holdCall = machine.match(/if \(action === 'steer'\) \{[\s\S]{0,800}?\n        \}/)?.[0] ?? '';

    assert.ok(holdCall, 'the steer hold must exist');
    assert.equal(
        /this\.api\.hold\(itemId\)\.catch\(\(\) => undefined\)/.test(machine),
        false,
        'discarding the hold failure lets the item drain underneath the armed steer',
    );
    assert.match(holdCall, /phase: 'error'/, 'the failure must reach the overlay the row already renders');
});
