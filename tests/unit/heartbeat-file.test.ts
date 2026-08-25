import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { HEARTBEAT_JOBS_PATH, loadHeartbeatFile, saveHeartbeatFile } from '../../src/core/config.ts';
import { clearPromptCache, getSystemPrompt } from '../../src/prompt/builder.ts';
import { normalizeHeartbeatPutRunnerFields, resolveHeartbeatDestination } from '../../src/routes/heartbeat.ts';

test('loadHeartbeatFile returns empty jobs only when heartbeat file is absent', () => {
    fs.rmSync(HEARTBEAT_JOBS_PATH, { force: true });
    assert.deepEqual(loadHeartbeatFile(), { jobs: [] });
});

test('loadHeartbeatFile fails closed on malformed heartbeat file', () => {
    fs.writeFileSync(HEARTBEAT_JOBS_PATH, '{ not-json');
    try {
        assert.throws(() => loadHeartbeatFile(), /heartbeat_load_failed/);
    } finally {
        fs.rmSync(HEARTBEAT_JOBS_PATH, { force: true });
        saveHeartbeatFile({ jobs: [] });
    }
});

test('system prompt surfaces malformed heartbeat file instead of silently dropping jobs', () => {
    clearPromptCache();
    fs.writeFileSync(HEARTBEAT_JOBS_PATH, '{ not-json');
    try {
        const prompt = getSystemPrompt({ forDisk: false });
        assert.match(prompt, /Heartbeat file failed to load:/);
        assert.match(prompt, /heartbeat_load_failed/);
    } finally {
        fs.rmSync(HEARTBEAT_JOBS_PATH, { force: true });
        saveHeartbeatFile({ jobs: [] });
        clearPromptCache();
    }
});

test('heartbeat schema defaults remain main/always and invalid runner fails soft', () => {
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    try {
        saveHeartbeatFile({ jobs: [{ id: 'legacy', prompt: 'same' }, { id: 'bad', runner: 'bogus' as never }] });
        const jobs = loadHeartbeatFile().jobs;
        assert.deepEqual(jobs[0], { id: 'legacy', prompt: 'same', runner: 'main', reportPolicy: 'always' });
        assert.equal(jobs[1]?.runner, 'main');
        assert.equal(warnings.length, 1);
    } finally {
        console.warn = warn;
        saveHeartbeatFile({ jobs: [] });
    }
});

test('manager-shaped PUT preserves runner fields by existing job id', () => {
    const existing = { runner: 'script' as const, command: [process.execPath, '-e', "console.log('ok')"], reportPolicy: 'anomaly_only' as const };
    const strippedManagerJob = { id: 'script-job', name: 'script', enabled: true, schedule: { minutes: 5 }, prompt: 'check' };
    const result = normalizeHeartbeatPutRunnerFields(strippedManagerJob, existing, new Set());
    assert.deepEqual(result, { ok: true, fields: existing });
});

test('PUT normalization rejects an unknown employee', () => {
    const result = normalizeHeartbeatPutRunnerFields({ runner: 'employee', employee: 'missing' }, undefined, new Set(['known']));
    assert.deepEqual(result, { ok: false, error: 'unknown heartbeat employee' });
});

// ─── destination survives a UI save (#437) ──────────
//
// Every shipped UI rebuilds a job from a fixed five-field shape, so a field they
// do not render is absent from the PUT body. If absence meant "clear", one
// ordinary "Save jobs" click would silently unpin every scheduled report and
// hand it back to the last-active resolver — the exact bug being fixed.

test('a UI-shaped PUT that omits destination preserves the stored one', () => {
    const existing = { channel: 'slack' as const, targetId: 'C_REPORTS', threadId: '1787616871.254919' };
    const strippedUiJob = { id: 'pinned', name: 'pinned', enabled: true, schedule: { minutes: 5 }, prompt: 'check' };
    const result = resolveHeartbeatDestination(strippedUiJob, existing);
    assert.deepEqual(result, { ok: true, destination: existing });
});

test('an explicit null clears the destination', () => {
    const existing = { channel: 'slack' as const, targetId: 'C_REPORTS' };
    const result = resolveHeartbeatDestination({ destination: null }, existing);
    assert.deepEqual(result, { ok: true, destination: undefined },
        'unsetting must remain possible, so null is not folded into absence');
});

test('a supplied destination replaces the stored one', () => {
    const result = resolveHeartbeatDestination(
        { destination: { channel: 'slack', targetId: 'C_NEW' } },
        { channel: 'slack', targetId: 'C_OLD' },
    );
    assert.deepEqual(result, { ok: true, destination: { channel: 'slack', targetId: 'C_NEW' } });
});

test('a malformed destination is rejected rather than half-applied', () => {
    assert.deepEqual(
        resolveHeartbeatDestination({ destination: { channel: 'slack' } }, undefined),
        { ok: false, error: 'invalid heartbeat destination' });
    assert.deepEqual(
        resolveHeartbeatDestination({ destination: { channel: 'irc', targetId: 'x' } }, undefined),
        { ok: false, error: 'invalid heartbeat destination' });
});

test('no destination anywhere stays absent', () => {
    assert.deepEqual(resolveHeartbeatDestination({ id: 'j' }, undefined), { ok: true, destination: undefined });
});

test('a destination written directly to the file survives load', () => {
    const destination = { channel: 'slack' as const, targetId: 'C_REPORTS', threadId: '1787616871.254919' };
    try {
        saveHeartbeatFile({ jobs: [{ id: 'pinned', prompt: 'check', destination }] });
        assert.deepEqual(loadHeartbeatFile().jobs[0]?.destination, destination);
    } finally {
        saveHeartbeatFile({ jobs: [] });
    }
});

