import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    bumpSessionOwnershipGeneration,
    getSessionOwnershipGeneration,
    resetSessionOwnershipGenerationForTest,
    shouldPersistMainSession,
} from '../../src/agent/session-persistence.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

test('session persistence allows current owner to save successful non-fallback result', () => {
    resetSessionOwnershipGenerationForTest();
    const ownerGeneration = getSessionOwnershipGeneration();
    const ok = shouldPersistMainSession({
        ownerGeneration,
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
    const ownerGeneration = getSessionOwnershipGeneration();
    const ok = shouldPersistMainSession({
        ownerGeneration,
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
    const staleOwner = getSessionOwnershipGeneration();
    bumpSessionOwnershipGeneration();
    const ok = shouldPersistMainSession({
        ownerGeneration: staleOwner,
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
    const ownerGeneration = getSessionOwnershipGeneration();
    const ok = shouldPersistMainSession({
        ownerGeneration,
        cli: 'claude',
        model: 'sonnet',
        effort: 'medium',
        sessionId: 'failed',
        code: 1,
    });
    assert.equal(ok, false);
});

test('spawn.ts uses shared persistence and resume-classifier helpers', () => {
    const src = fs.readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    assert.ok(src.includes('persistMainSession({'), 'spawn should use shared persistence helper');
    assert.ok(src.includes('shouldInvalidateResumeSession('), 'spawn should use shared resume classifier');
});
