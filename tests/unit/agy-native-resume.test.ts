import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { buildResumeArgs } from '../../src/agent/args.js';
import {
    AGY_RESUME_TTL_MS,
    canGuardedAgyResume,
    resolveAgyNativeResume,
    shouldClearHighTurnSessionBucket,
    shouldUseTurnCountRefresh,
    type GuardedAgyResumeInput,
} from '../../src/agent/spawn/resume.js';

const now = Date.UTC(2026, 6, 11, 0, 0, 0);
const passing: GuardedAgyResumeInput = {
    mode: 'guarded', conversationSupported: true, sessionId: 'conv-123',
    bucketUpdatedAt: now - 1_000, requestedModel: 'default', bucketModel: 'default',
    cwd: '/project', lastRunCwd: '/project', lastRunClean: 1,
    lastRunMeta: JSON.stringify({ checkpointSeen: false, plannerOnly: false, exitCode: 0, at: now }),
    freshBootstrap: false, nowMs: now,
};

test('AGY-NR-001: native resume setting is exact opt-in and defaults off', () => {
    assert.equal(resolveAgyNativeResume(undefined), 'off');
    assert.equal(resolveAgyNativeResume('GUARDED'), 'off');
    assert.equal(resolveAgyNativeResume('guarded'), 'guarded');
});

test('AGY-NR-002: all-pass guard enables exact conversation print argv', () => {
    assert.deepEqual(canGuardedAgyResume(passing), { ok: true, reason: 'guarded-resume' });
    const argv = buildResumeArgs('agy', 'default', '', 'conv-123', 'next', 'auto', {
        agyCapabilities: {
            conversation: true, print: true, printFlag: '--print', model: false,
            printTimeout: false, logFile: false, addDir: false,
            dangerousSkipPermissions: false, sandbox: false, usedFallback: false,
        },
    });
    assert.deepEqual(argv.slice(0, 4), ['--conversation', 'conv-123', '--print', 'next']);
});

test('AGY-NR-003: each failed guard selects a distinct fresh-path reason', () => {
    const cases: Array<[string, Partial<GuardedAgyResumeInput>, string]> = [
        ['default off', { mode: 'off' }, 'mode-off'],
        ['capability', { conversationSupported: false }, 'no-conversation-capability'],
        ['ttl', { bucketUpdatedAt: now - AGY_RESUME_TTL_MS - 1 }, 'ttl-expired'],
        ['model', { bucketModel: 'other' }, 'model-mismatch'],
        ['cwd', { lastRunCwd: '/other' }, 'cwd-mismatch'],
        ['unclean', { lastRunClean: 0 }, 'last-run-not-clean'],
        ['missing columns', { lastRunClean: undefined }, 'last-run-not-clean'],
        ['planner', { lastRunMeta: JSON.stringify({ checkpointSeen: false, plannerOnly: true }) }, 'planner-only'],
        ['checkpoint', { lastRunMeta: JSON.stringify({ checkpointSeen: true, plannerOnly: false }) }, 'checkpoint-seen'],
    ];
    for (const [name, override, reason] of cases) {
        assert.deepEqual(canGuardedAgyResume({ ...passing, ...override }), { ok: false, reason }, name);
    }
});

test('AGY-NR-004: guarded stale fallback is one-shot and replay stripping stays unconditional', () => {
    const source = fs.readFileSync(new URL('../../src/agent/spawn.ts', import.meta.url), 'utf8');
    assert.match(source, /agyResumeDecision\.ok && !opts\._agyStaleFreshRetry/);
    assert.match(source, /_agyStaleFreshRetry: true, _skipResume: true/);
    assert.equal((source.match(/_agyStaleFreshRetry: true/g) || []).length, 1);
    assert.match(source, /if \(isResume && agyResumeReplayPrefixes\.length > 0\)/);
    assert.match(source, /stripAgyResumeReplayPrefixes\(ctx\.fullText, agyResumeReplayPrefixes\)/);
});

test('AGY-NR-005: generic high-turn policies preserve AGY native conversations', () => {
    assert.equal(shouldClearHighTurnSessionBucket('agy', 16), false);
    assert.equal(shouldClearHighTurnSessionBucket('agy', 80), false);
    assert.equal(shouldUseTurnCountRefresh('agy'), false);

    assert.equal(shouldClearHighTurnSessionBucket('codex', 16), true);
    assert.equal(shouldClearHighTurnSessionBucket('opencode', 16), true);
    assert.equal(shouldClearHighTurnSessionBucket('grok', 16), true);
    assert.equal(shouldClearHighTurnSessionBucket('codex', 15), false);
    assert.equal(shouldUseTurnCountRefresh('codex'), true);
    assert.equal(shouldUseTurnCountRefresh('claude'), false);
    assert.equal(shouldUseTurnCountRefresh('claude-e'), false);
});
