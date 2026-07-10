import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { consumePendingReminder, evaluateRecordPending } from '../../src/core/policy-flags.js';

function configuredHome(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-flags-'));
    fs.writeFileSync(path.join(dir, 'policy-hooks.json'), JSON.stringify({ flags: { recordPending: {
        enabled: true,
        toolPatterns: ['record-command'],
        clearPatterns: ['RECORD_DONE'],
        reminder: 'Finish the durable record.',
    } } }));
    return dir;
}

test('record_pending sets, reminds repeatedly, and clears', () => {
    const jawHome = configuredHome();
    evaluateRecordPending([{ command: 'record-command --phase wp1' }], 'working', { jawHome });
    const state = JSON.parse(fs.readFileSync(path.join(jawHome, 'policy-flags.json'), 'utf8'));
    assert.equal(state.flags.record_pending.set, true);
    assert.match(state.flags.record_pending.evidence, /record-command/);
    assert.equal(consumePendingReminder({ jawHome }), '[POLICY FLAG] record_pending\nFinish the durable record.');
    assert.equal(consumePendingReminder({ jawHome }), '[POLICY FLAG] record_pending\nFinish the durable record.');
    evaluateRecordPending([], 'RECORD_DONE', { jawHome });
    assert.equal(consumePendingReminder({ jawHome }), null);
});

test('missing config is inert and creates no state file', () => {
    const jawHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-flags-off-'));
    evaluateRecordPending([{ command: 'anything' }], 'text', { jawHome });
    assert.equal(consumePendingReminder({ jawHome }), null);
    assert.equal(fs.existsSync(path.join(jawHome, 'policy-flags.json')), false);
});

test('record_pending evaluates tool commands beyond the 400-char evidence excerpt', () => {
    const jawHome = configuredHome();
    evaluateRecordPending([
        { command: `noise-${'x'.repeat(500)}` },
        { command: 'record-command --after-long-prefix' },
    ], 'working', { jawHome });
    const state = JSON.parse(fs.readFileSync(path.join(jawHome, 'policy-flags.json'), 'utf8'));
    assert.equal(state.flags.record_pending.set, true);
    assert.equal(state.flags.record_pending.evidence.length, 400);
});
