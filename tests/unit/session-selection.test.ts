import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildClearedSessionRow,
    buildSelectedSessionRow,
    resolveMainCli,
} from '../../src/core/main-session.ts';
import { shouldIncludeVisionClickHint } from '../../src/prompt/builder.ts';

const baseSettings = {
    cli: 'codex',
    permissions: 'workspace-write',
    workingDir: '/tmp/jaw',
    activeOverrides: {},
    perCli: {
        codex: { model: 'gpt-5-codex', effort: 'high' },
        claude: { model: 'sonnet', effort: 'medium' },
    },
};

test('resolveMainCli prefers explicit request over settings and session', () => {
    const cli = resolveMainCli('claude', baseSettings, { active_cli: 'gemini' });
    assert.equal(cli, 'claude');
});

test('resolveMainCli prefers settings over stale session row', () => {
    const cli = resolveMainCli(undefined, baseSettings, { active_cli: 'claude' });
    assert.equal(cli, 'codex');
});

test('buildSelectedSessionRow clears session id when selected CLI changed', () => {
    const row = buildSelectedSessionRow(baseSettings, {
        active_cli: 'claude',
        session_id: 'old-session',
    }, 'claude');
    assert.equal(row.cli, 'codex');
    assert.equal(row.sessionId, null);
    assert.equal(row.model, 'gpt-5-codex');
    assert.equal(row.effort, 'high');
});

test('buildClearedSessionRow preserves settings intent rather than stale DB CLI', () => {
    const row = buildClearedSessionRow(baseSettings, {
        active_cli: 'claude',
        session_id: 'stale',
        model: 'sonnet',
        effort: 'medium',
    });
    assert.equal(row.cli, 'codex');
    assert.equal(row.sessionId, null);
    assert.equal(row.model, 'gpt-5-codex');
    assert.equal(row.effort, 'high');
});

test('shouldIncludeVisionClickHint follows intended CLI', () => {
    assert.equal(shouldIncludeVisionClickHint('codex'), true);
    assert.equal(shouldIncludeVisionClickHint('claude'), false);
    assert.equal(shouldIncludeVisionClickHint(undefined), false);
});
