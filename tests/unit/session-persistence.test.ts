import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveScopedSessionBucket } from '../../src/agent/args.ts';
import {
    bumpScopeSessionGeneration,
    bumpSessionOwnershipGeneration,
    getSessionOwnershipGeneration,
    isCurrentSessionOwner,
    resetSessionOwnershipGenerationForTest,
    shouldPersistMainSession,
} from '../../src/agent/session-persistence.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

test('session persistence allows current owner to save successful non-fallback result', () => {
    resetSessionOwnershipGenerationForTest();
    const scopeKey = 'default';
    const persistenceOwner = getSessionOwnershipGeneration(scopeKey);
    const ok = shouldPersistMainSession({
        persistenceOwner,
        scopeKey,
        cli: 'codex',
        model: 'gpt-5-codex',
        effort: 'high',
        sessionId: 'abc',
        code: 0,
    });
    assert.equal(ok, true);
});

test('session persistence blocks fallback runs from saving main session row', () => {
    resetSessionOwnershipGenerationForTest();
    const scopeKey = 'default';
    const persistenceOwner = getSessionOwnershipGeneration(scopeKey);
    const ok = shouldPersistMainSession({
        persistenceOwner,
        scopeKey,
        cli: 'copilot',
        model: 'default',
        effort: '',
        sessionId: 'fallback-session',
        isFallback: true,
        code: 0,
    });
    assert.equal(ok, false);
});

test('session persistence blocks stale owner after generation bump', () => {
    resetSessionOwnershipGenerationForTest();
    const scopeKey = 'default';
    const staleOwner = getSessionOwnershipGeneration(scopeKey);
    bumpSessionOwnershipGeneration();
    const ok = shouldPersistMainSession({
        persistenceOwner: staleOwner,
        scopeKey,
        cli: 'claude',
        model: 'sonnet',
        effort: 'medium',
        sessionId: 'stale-owner',
        code: 0,
    });
    assert.equal(ok, false);
});

test('session persistence blocks non-zero exits', () => {
    resetSessionOwnershipGenerationForTest();
    const scopeKey = 'default';
    const persistenceOwner = getSessionOwnershipGeneration(scopeKey);
    const ok = shouldPersistMainSession({
        persistenceOwner,
        scopeKey,
        cli: 'claude',
        model: 'sonnet',
        effort: 'medium',
        sessionId: 'failed',
        code: 1,
    });
    assert.equal(ok, false);
});

test('session persistence treats ai-e exit code 2 as graceful only for Claude provider', () => {
    resetSessionOwnershipGenerationForTest();
    const scopeKey = 'default';
    const persistenceOwner = getSessionOwnershipGeneration(scopeKey);
    assert.equal(shouldPersistMainSession({
        persistenceOwner,
        scopeKey,
        cli: 'ai-e',
        provider: 'claude',
        model: 'sonnet',
        effort: 'medium',
        sessionId: 'ai-e-claude-interrupted',
        code: 2,
    }), true);
    assert.equal(shouldPersistMainSession({
        persistenceOwner,
        scopeKey,
        cli: 'ai-e',
        provider: 'codex',
        model: 'gpt-5.4',
        effort: 'medium',
        sessionId: 'ai-e-codex-interrupted',
        code: 2,
    }), true);
});

test('session persistence skips ai-e headless provider session ids', () => {
    resetSessionOwnershipGenerationForTest();
    const scopeKey = 'default';
    const persistenceOwner = getSessionOwnershipGeneration(scopeKey);
    assert.equal(shouldPersistMainSession({
        persistenceOwner,
        scopeKey,
        cli: 'ai-e',
        provider: 'gemini',
        model: 'gemini-3-flash-preview',
        effort: '',
        sessionId: 'headless-native-session',
        code: 0,
    }), false);
});

test('session ownership tracks scoped and global invalidation independently', () => {
    resetSessionOwnershipGenerationForTest();
    const scopeAOwner = getSessionOwnershipGeneration('scope-a');
    const scopeBOwner = getSessionOwnershipGeneration('scope-b');

    bumpScopeSessionGeneration('scope-a');
    assert.equal(isCurrentSessionOwner(scopeAOwner, 'scope-a'), false);
    assert.equal(isCurrentSessionOwner(scopeBOwner, 'scope-b'), true);

    bumpSessionOwnershipGeneration();
    assert.equal(isCurrentSessionOwner(scopeBOwner, 'scope-b'), false);

    resetSessionOwnershipGenerationForTest();
    assert.deepEqual(getSessionOwnershipGeneration('scope-a'), { global: 0, scope: 0 });
});

test('agent system uses shared persistence and resume-classifier helpers', () => {
    const spawnSrc = fs.readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    const lifecycleSrc = fs.readFileSync(join(__dirname, '../../src/agent/lifecycle-handler.ts'), 'utf8');
    // persistMainSession is called in spawn.ts (ACP pre-shutdown) and lifecycle-handler.ts (exit handler)
    assert.ok(spawnSrc.includes('persistMainSession(') || lifecycleSrc.includes('persistMainSession('),
        'system should use shared persistence helper');
    // shouldInvalidateResumeSession is called in lifecycle-handler.ts (unified exit handler)
    assert.ok(lifecycleSrc.includes('shouldInvalidateResumeSession('),
        'lifecycle handler should use shared resume classifier');
});

test('codex-app buckets match native and fallback lane identity', () => {
    assert.equal(
        resolveScopedSessionBucket('codex-app', 'gpt-5.5', null, 'scope-a', 'high', 'native'),
        'codex-app:scope-a',
    );
    assert.equal(
        resolveScopedSessionBucket('codex-app', 'gpt-5.5', null, 'scope-a', 'high', 'fallback'),
        'codex-app:scope-a:gpt-5.5:high',
    );
    assert.equal(
        resolveScopedSessionBucket('codex-app', 'gpt-5.5', null, 'scope-a', 'low', 'fallback'),
        'codex-app:scope-a:gpt-5.5:low',
    );
    assert.equal(
        resolveScopedSessionBucket('pi', 'default', null, 'scope-a', 'high', 'native'),
        'pi',
    );
});

test('codex-app bucket persistence, copy, compact, and reset preserve isolation', () => {
    const home = mkdtempSync(join(tmpdir(), 'cli-jaw-codex-bucket-copy-'));
    const fixture = join(__dirname, '../fixtures/codex-session-bucket-db-child.mts');
    try {
        const result = spawnSync(process.execPath, ['--import', 'tsx', fixture], {
            env: { ...process.env, CLI_JAW_HOME: home },
            encoding: 'utf8',
            timeout: 30_000,
        });
        assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join('\n'));
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});
