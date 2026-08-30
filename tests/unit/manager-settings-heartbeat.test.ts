// Phase 5 — Heartbeat scheduler & jobs primitives.
//
// Pure helpers + dirty-store wiring for the Heartbeat page. Verifies:
//   • interval regex (`\d+[smh]`) and HH:MM regex
//   • makeDefaultJob seeds an `every` schedule with 30 minutes
//   • normalizeJobsResponse defends against malformed payloads
//   • jobScheduleBodyError flags bad minutes / bad cron
//   • isHeartbeatSettingsKey partitions shared-bundle vs page-local
//   • dirty store wires three independent save namespaces
//   • saveBundle filtered to heartbeat.* expands into nested patch
//   • removing a job leaves the dirty entry set with the new array
//   • heartbeat.jobs / heartbeat.md never reach the /api/settings patch

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDirtyStore } from '../../public/manager/src/settings/dirty-store';
import { expandPatch } from '../../public/manager/src/settings/pages/path-utils';
import {
    isHeartbeatSettingsKey,
    jobScheduleBodyError,
    jobsHaveErrors,
    makeDefaultJob,
    normalizeJobsResponse,
    validateHHMM,
    validateInterval,
    SECTION_A_KEYS,
    PAGE_LOCAL_KEYS,
} from '../../public/manager/src/settings/pages/Heartbeat';

// ─── interval / HH:MM regexes ────────────────────────────────────────

test('validateInterval accepts 30s, 5m, 2h', () => {
    assert.equal(validateInterval('30s'), true);
    assert.equal(validateInterval('5m'), true);
    assert.equal(validateInterval('2h'), true);
    assert.equal(validateInterval('  30m  '), true);
});

test('validateInterval rejects bare numbers, suffix-only, and bad shapes', () => {
    assert.equal(validateInterval('30'), false);
    assert.equal(validateInterval('m'), false);
    assert.equal(validateInterval('30ms'), false);
    assert.equal(validateInterval(''), false);
    assert.equal(validateInterval('1d'), false);
});

test('validateHHMM accepts 00:00..23:59', () => {
    assert.equal(validateHHMM('00:00'), true);
    assert.equal(validateHHMM('08:30'), true);
    assert.equal(validateHHMM('23:59'), true);
});

test('validateHHMM rejects 24:00, single digits, and free-form text', () => {
    assert.equal(validateHHMM('24:00'), false);
    assert.equal(validateHHMM('8:30'), false);
    assert.equal(validateHHMM('08-30'), false);
    assert.equal(validateHHMM(''), false);
    assert.equal(validateHHMM('morning'), false);
});

// ─── makeDefaultJob ──────────────────────────────────────────────────

test('makeDefaultJob seeds an enabled `every` job with 30 minutes', () => {
    const job = makeDefaultJob(123);
    // Prefixed with the timestamp, plus a per-call suffix. The exact string is
    // deliberately not asserted: what matters is that two jobs added in the same
    // millisecond differ, since the server rejects a duplicate id now.
    assert.match(job.id, /^hb_123_\d+$/);
    assert.notEqual(makeDefaultJob(123).id, makeDefaultJob(123).id);
    assert.equal(job.name, '');
    assert.equal(job.enabled, true);
    assert.equal(job.prompt, '');
    assert.equal(job.schedule.kind, 'every');
    if (job.schedule.kind === 'every') {
        assert.equal(job.schedule.minutes, 30);
    }
});

// ─── normalizeJobsResponse ───────────────────────────────────────────

test('normalizeJobsResponse returns [] for nullish / non-object payloads', () => {
    assert.deepEqual(normalizeJobsResponse(null), []);
    assert.deepEqual(normalizeJobsResponse(undefined), []);
    assert.deepEqual(normalizeJobsResponse('garbage'), []);
});

test('normalizeJobsResponse returns [] when jobs is missing or non-array', () => {
    assert.deepEqual(normalizeJobsResponse({}), []);
    assert.deepEqual(normalizeJobsResponse({ jobs: 'not-array' }), []);
});

test('normalizeJobsResponse parses valid every + cron jobs and assigns fallback ids', () => {
    const jobs = normalizeJobsResponse({
        jobs: [
            {
                id: 'a',
                name: 'morning',
                enabled: true,
                schedule: { kind: 'cron', cron: '0 9 * * *', timeZone: 'Asia/Seoul' },
                prompt: 'hello',
            },
            {
                // missing id → fallback hb_unknown_1
                name: 'tick',
                schedule: { kind: 'every', minutes: 5 },
            },
        ],
    });
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0]?.id, 'a');
    assert.equal(jobs[0]?.schedule.kind, 'cron');
    assert.equal(jobs[1]?.id, 'hb_unknown_1');
    assert.equal(jobs[1]?.enabled, true);
    if (jobs[1]?.schedule.kind === 'every') {
        assert.equal(jobs[1].schedule.minutes, 5);
    }
});

test('normalizeJobsResponse defaults bad schedule shape to every:30', () => {
    const jobs = normalizeJobsResponse({
        jobs: [{ id: 'x', name: 'broken', schedule: 'not-an-object' }],
    });
    assert.equal(jobs[0]?.schedule.kind, 'every');
    if (jobs[0]?.schedule.kind === 'every') {
        assert.equal(jobs[0].schedule.minutes, 30);
    }
});

// ─── schedule body validation ────────────────────────────────────────

test('jobScheduleBodyError flags non-positive / non-integer minutes', () => {
    assert.equal(
        jobScheduleBodyError({ kind: 'every', minutes: 0 }),
        'Minutes must be a positive integer',
    );
    assert.equal(
        jobScheduleBodyError({ kind: 'every', minutes: -1 }),
        'Minutes must be a positive integer',
    );
    assert.equal(
        jobScheduleBodyError({ kind: 'every', minutes: 1.5 }),
        'Minutes must be a positive integer',
    );
    assert.equal(
        jobScheduleBodyError({ kind: 'every', minutes: NaN }),
        'Minutes must be a positive integer',
    );
});

test('jobScheduleBodyError accepts a positive integer minutes', () => {
    assert.equal(jobScheduleBodyError({ kind: 'every', minutes: 30 }), null);
});

test('jobScheduleBodyError flags empty / short cron expressions', () => {
    assert.equal(
        jobScheduleBodyError({ kind: 'cron', cron: '' }),
        'Cron expression required',
    );
    assert.equal(
        jobScheduleBodyError({ kind: 'cron', cron: '0 9 *' }),
        'Cron must have at least 5 fields',
    );
});

test('jobScheduleBodyError accepts a 5-field cron expression', () => {
    assert.equal(
        jobScheduleBodyError({ kind: 'cron', cron: '0 9 * * *' }),
        null,
    );
});

test('jobsHaveErrors returns true if any job has a body error', () => {
    assert.equal(
        jobsHaveErrors([
            { ...makeDefaultJob(1), schedule: { kind: 'every', minutes: 0 } },
        ]),
        true,
    );
    assert.equal(jobsHaveErrors([makeDefaultJob(1), makeDefaultJob(2)]), false);
    assert.equal(jobsHaveErrors([]), false);
});

// ─── settings-key partitioning ───────────────────────────────────────

test('isHeartbeatSettingsKey accepts heartbeat.* but rejects page-local keys', () => {
    for (const key of SECTION_A_KEYS) {
        assert.equal(
            isHeartbeatSettingsKey(key),
            true,
            `expected ${key} to be a settings key`,
        );
    }
    for (const key of PAGE_LOCAL_KEYS) {
        assert.equal(
            isHeartbeatSettingsKey(key),
            false,
            `expected ${key} to NOT be a settings key`,
        );
    }
    assert.equal(isHeartbeatSettingsKey('telegram.token'), false);
});

// ─── dirty store wiring ──────────────────────────────────────────────

test('Section A activeHours edits expand to nested heartbeat.activeHours patch', () => {
    const store = createDirtyStore();
    store.set('heartbeat.activeHours.start', {
        value: '09:00',
        original: '08:00',
        valid: true,
    });
    store.set('heartbeat.activeHours.end', {
        value: '23:00',
        original: '22:00',
        valid: true,
    });
    const filtered: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(store.saveBundle())) {
        if (isHeartbeatSettingsKey(k)) filtered[k] = v;
    }
    assert.deepEqual(expandPatch(filtered), {
        heartbeat: { activeHours: { start: '09:00', end: '23:00' } },
    });
});

test('Adding a job sets heartbeat.jobs dirty entry with the new array', () => {
    const store = createDirtyStore();
    const before = [makeDefaultJob(1)];
    const after = [...before, makeDefaultJob(2)];
    store.set('heartbeat.jobs', { value: after, original: before, valid: true });
    assert.equal(store.isDirty(), true);
    assert.equal(store.pending.has('heartbeat.jobs'), true);
});

test('Removing a job leaves dirty set with the shrunk array', () => {
    const store = createDirtyStore();
    const original = [makeDefaultJob(1), makeDefaultJob(2)];
    const after = [original[0]!];
    store.set('heartbeat.jobs', { value: after, original, valid: true });
    assert.equal(store.isDirty(), true);
    const entry = store.pending.get('heartbeat.jobs');
    assert.ok(entry);
    assert.equal(Array.isArray(entry.value) ? entry.value.length : -1, 1);
});

test('heartbeat.jobs and heartbeat.md never reach the /api/settings patch', () => {
    const store = createDirtyStore();
    store.set('heartbeat.enabled', { value: true, original: false, valid: true });
    store.set('heartbeat.jobs', {
        value: [makeDefaultJob(1)],
        original: [],
        valid: true,
    });
    store.set('heartbeat.md', { value: 'hello', original: '', valid: true });
    const filtered: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(store.saveBundle())) {
        if (isHeartbeatSettingsKey(k)) filtered[k] = v;
    }
    assert.deepEqual(expandPatch(filtered), {
        heartbeat: { enabled: true },
    });
});

test('Reverting heartbeat.every clears its dirty entry (no leak)', () => {
    const store = createDirtyStore();
    store.set('heartbeat.every', { value: '5m', original: '30m', valid: true });
    store.set('heartbeat.every', { value: '30m', original: '30m', valid: true });
    assert.equal(store.pending.has('heartbeat.every'), false);
});

test('Invalid jobs entry is dropped from saveBundle', () => {
    const store = createDirtyStore();
    store.set('heartbeat.jobs', {
        value: [makeDefaultJob(1)],
        original: [],
        valid: false,
    });
    const bundle = store.saveBundle();
    assert.equal(Object.prototype.hasOwnProperty.call(bundle, 'heartbeat.jobs'), false);
});
