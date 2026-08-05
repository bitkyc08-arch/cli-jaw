// 110 ON-16, ON-18, ON-20, ON-24 asked for the one thing the unit tests around 073 kept
// stopping short of: not "is the key computed correctly" but "does a session get its own
// conversation back". Every axis of 073 is only worth anything if the id a run writes is
// the id the next run of THAT session reads, and no other session's read finds it.
//
// The round trip is checkable without a vendor binary, because both halves are ordinary
// functions over one table: persistMainSession() writes, and spawnAgent() resolves what
// to resume with resolveScopedSessionBucket() + getSessionBucket. This file drives the
// real write and the real key resolution against the real DB.
import '../setup/isolated-home.ts';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { db, getSessionBucket, upsertSessionBucket } from '../../src/core/db.ts';
import { aiEProviderForBucket, resolveScopedSessionBucket } from '../../src/agent/args.ts';
import {
    getSessionOwnershipGeneration,
    persistMainSession,
    resetSessionOwnershipGenerationForTest,
} from '../../src/agent/session-persistence.ts';
import { scopeForChatSession } from '../../src/orchestrator/scope.ts';

afterEach(() => {
    db.prepare('DELETE FROM session_buckets').run();
    db.prepare("UPDATE session SET session_id = NULL WHERE id = 'default'").run();
    resetSessionOwnershipGenerationForTest();
});

/** What a run saves at exit. */
function saveTurn(scopeKey: string, cli: string, model: string, sessionId: string, opts: {
    provider?: string;
    scopedBucket?: string;
} = {}): boolean {
    return persistMainSession({
        persistenceOwner: getSessionOwnershipGeneration(scopeKey),
        scopeKey,
        cli,
        model,
        effort: 'medium',
        sessionId,
        code: 0,
        ...(opts.provider ? { provider: opts.provider } : {}),
        ...(opts.scopedBucket ? { scopedBucket: opts.scopedBucket } : {}),
    });
}

/** What the next run of the same session looks up before deciding to resume. */
function resumeIdFor(scopeKey: string, cli: string, model: string, opts: {
    provider?: string | null;
    multiplex?: boolean;
    laneMode?: 'native' | 'fallback';
} = {}): string | null {
    const bucket = resolveScopedSessionBucket(
        cli, model, opts.provider ?? null, scopeKey, 'medium',
        opts.laneMode ?? 'fallback', opts.multiplex ?? false,
    );
    const row = getSessionBucket.get(bucket) as { session_id?: string } | undefined;
    return row?.session_id ?? null;
}

// ON-16 — the default runtime, in its default configuration, on a second session.
test('a second session resumes its own conversation and not the default one', () => {
    const b = scopeForChatSession('sess-b');

    assert.equal(saveTurn('default', 'codex-app', 'gpt-5.5', 'thread-of-default'), true);
    assert.equal(saveTurn(b, 'codex-app', 'gpt-5.5', 'thread-of-b'), true);

    assert.equal(resumeIdFor(b, 'codex-app', 'gpt-5.5'), 'thread-of-b');
    assert.equal(resumeIdFor('default', 'codex-app', 'gpt-5.5'), 'thread-of-default');
});

// ON-18 — a local session and a Slack session on the same runtime.
test('a local session and a Slack session keep separate conversations', () => {
    const local = scopeForChatSession('sess-local');
    const slack = scopeForChatSession('sess-slack', 'jaw:slack:T1:C1');
    assert.equal(slack, 'jaw:slack:T1:C1', 'a remote key is the scope itself');

    assert.equal(saveTurn(local, 'claude', 'default', 'thread-local'), true);
    assert.equal(saveTurn(slack, 'claude', 'default', 'thread-slack'), true);

    assert.equal(resumeIdFor(local, 'claude', 'default'), 'thread-local');
    assert.equal(resumeIdFor(slack, 'claude', 'default'), 'thread-slack');
    assert.equal(resumeIdFor('default', 'claude', 'default'), null,
        'neither of them may leave anything in the default session bucket');
});

// ON-20 — the upgrade case. A session that predates 073 has been resuming from the bare
// bucket name all along, and must carry on from that same conversation afterwards.
test('a session that predates the change keeps resuming its existing conversation', () => {
    upsertSessionBucket.run('claude', 'thread-from-before-073', 'default', null, 0);

    assert.equal(resumeIdFor('default', 'claude', 'default'), 'thread-from-before-073');

    assert.equal(saveTurn('default', 'claude', 'default', 'thread-after-073'), true);
    assert.equal(resumeIdFor('default', 'claude', 'default'), 'thread-after-073',
        'and its next turn continues in the same row rather than starting a second one');
    const rows = db.prepare('SELECT COUNT(*) AS n FROM session_buckets').get() as { n: number };
    assert.equal(rows.n, 1, 'no parallel row appears beside the legacy one');
});

// The write half of ON-24's concern, and the reason the fallback had to be scoped: a
// caller that names no bucket must not land on the row another session resumes from.
test('a save that names no bucket still stays inside its own scope', () => {
    upsertSessionBucket.run('copilot', 'thread-of-default', 'default', null, 0);
    const b = scopeForChatSession('sess-b');

    assert.equal(saveTurn(b, 'copilot', 'default', 'thread-of-b'), true);

    assert.equal(resumeIdFor('default', 'copilot', 'default'), 'thread-of-default',
        'the default session keeps the conversation it was resuming');
    assert.equal(resumeIdFor(b, 'copilot', 'default'), 'thread-of-b');
});

// ai-e keys its bucket by provider, so the round trip has to hold per provider too.
// A write that resolves one provider and a read that resolves another loses the resume
// silently — the conversation is still in the table, under a name nobody asks for.
test('an ai-e session round-trips under the provider it was configured with', () => {
    const b = scopeForChatSession('sess-b');

    assert.equal(saveTurn(b, 'ai-e', 'auto', 'thread-kiro', { provider: 'kiro' }), true);

    assert.equal(resumeIdFor(b, 'ai-e', 'auto', { provider: 'kiro' }), 'thread-kiro');
    assert.equal(resumeIdFor(b, 'ai-e', 'auto', { provider: 'claude' }), null,
        'another provider is a different conversation, not the same one');
});

// Compact and reset name a bucket without a run to ask, so they read the provider from
// settings. They each used to do that separately and one passed nothing, which sent the
// clear to whichever provider the model name happened to imply. One helper now answers
// for all of them, and it has to agree with what the run itself resolved.
test('a configured ai-e provider beats what the model name implies', () => {
    const configured = {
        perCli: { 'ai-e': { provider: 'kiro' } },
        activeOverrides: {},
    };
    // `gpt-5.5` infers `codex`; the configuration says otherwise and wins.
    assert.equal(aiEProviderForBucket('ai-e', 'gpt-5.5', configured), 'kiro');
    assert.equal(aiEProviderForBucket('ai-e', 'gpt-5.5', null), 'codex',
        'with nothing configured the model name is all there is');
    assert.equal(aiEProviderForBucket('claude', 'gpt-5.5', configured), null,
        'no other runtime keys its bucket by provider');

    const overrideOnly = { perCli: {}, activeOverrides: { 'ai-e': { provider: 'grok' } } };
    assert.equal(aiEProviderForBucket('ai-e', 'gpt-5.5', overrideOnly), 'grok');
});

// The point of that agreement: a save and the clear that follows must name one row.
test('a save and a settings-driven clear name the same ai-e bucket', () => {
    const b = scopeForChatSession('sess-b');
    const configured = { perCli: { 'ai-e': { provider: 'kiro' } }, activeOverrides: {} };

    // The run resolves its provider from the same settings and saves under it.
    const runProvider = aiEProviderForBucket('ai-e', 'gpt-5.5', configured);
    assert.equal(saveTurn(b, 'ai-e', 'gpt-5.5', 'thread-kiro', { provider: runProvider! }), true);

    // A compact or reset asking the helper lands on that same row rather than `ai-e:codex`.
    assert.equal(resumeIdFor(b, 'ai-e', 'gpt-5.5', { provider: runProvider }), 'thread-kiro');
    assert.equal(resumeIdFor(b, 'ai-e', 'gpt-5.5', { provider: null }), null,
        'the inferred provider names an empty bucket, which is what the defect looked like');
});

// codex-app multiplex folds the lane into the key. Both lane modes belong to the same
// session, but they are different conversations, and neither may reach the other scope.
test('codex-app multiplex lanes stay inside their own session', () => {
    const b = scopeForChatSession('sess-b');
    const nativeBucket = resolveScopedSessionBucket('codex-app', 'gpt-5.5', null, b, 'medium', 'native', true);
    const fallbackBucket = resolveScopedSessionBucket('codex-app', 'gpt-5.5', null, b, 'medium', 'fallback', true);
    assert.notEqual(nativeBucket, fallbackBucket);

    assert.equal(saveTurn(b, 'codex-app', 'gpt-5.5', 'thread-native', { scopedBucket: nativeBucket }), true);
    assert.equal(saveTurn(b, 'codex-app', 'gpt-5.5', 'thread-fallback', { scopedBucket: fallbackBucket }), true);

    assert.equal(resumeIdFor(b, 'codex-app', 'gpt-5.5', { multiplex: true, laneMode: 'native' }), 'thread-native');
    assert.equal(resumeIdFor(b, 'codex-app', 'gpt-5.5', { multiplex: true, laneMode: 'fallback' }), 'thread-fallback');
    assert.equal(resumeIdFor('default', 'codex-app', 'gpt-5.5', { multiplex: true, laneMode: 'native' }), null);
});
