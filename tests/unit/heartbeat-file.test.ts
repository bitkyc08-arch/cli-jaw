import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { HEARTBEAT_JOBS_PATH, loadHeartbeatFile, saveHeartbeatFile } from '../../src/core/config.ts';
import { clearPromptCache, getSystemPrompt } from '../../src/prompt/builder.ts';
import { normalizeHeartbeatPutRunnerFields } from '../../src/routes/heartbeat.ts';

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
