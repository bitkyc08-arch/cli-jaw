import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
    buildJwcModelOptions,
    readJwcModelUsageOrder,
} from '../../src/code-mode/model-options.ts';

test('JWC model usage helper reads most-recently-used order from agent db', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'cli-jaw-jwc-usage-'));
    try {
        const db = new Database(join(agentDir, 'agent.db'));
        db.exec(`
            CREATE TABLE model_usage (
                model_key TEXT PRIMARY KEY,
                last_used_at INTEGER NOT NULL
            );
            INSERT INTO model_usage (model_key, last_used_at) VALUES
              ('anthropic/claude-sonnet-4-6', 10),
              ('openai-codex/gpt-5.4-mini', 30),
              ('openai-codex/gpt-5.4', 20);
        `);
        db.close();

        assert.deepEqual(readJwcModelUsageOrder(agentDir), [
            'openai-codex/gpt-5.4-mini',
            'openai-codex/gpt-5.4',
            'anthropic/claude-sonnet-4-6',
        ]);
    } finally {
        await rm(agentDir, { recursive: true, force: true });
    }
});

test('JWC model usage helper returns empty order when db or table is unavailable', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'cli-jaw-jwc-usage-'));
    try {
        assert.deepEqual(readJwcModelUsageOrder(agentDir), []);
        const db = new Database(join(agentDir, 'agent.db'));
        db.exec('CREATE TABLE other_table (id TEXT PRIMARY KEY);');
        db.close();
        assert.deepEqual(readJwcModelUsageOrder(agentDir), []);
    } finally {
        await rm(agentDir, { recursive: true, force: true });
    }
});

test('code model options sort configured default before MRU before static fallback', () => {
    const options = buildJwcModelOptions(
        ['openai-codex'],
        undefined,
        'openai-codex/gpt-5.3-codex',
        ['openai-codex/gpt-5.4-mini', 'openai-codex/gpt-5.4'],
    );

    assert.equal(options.defaultProvider, 'openai-codex');
    assert.equal(options.defaultModel, 'gpt-5.3-codex');
    assert.deepEqual(options.usageOrder, ['openai-codex/gpt-5.4-mini', 'openai-codex/gpt-5.4']);
    assert.deepEqual(options.providers[0]?.models, ['gpt-5.3-codex', 'gpt-5.4-mini', 'gpt-5.4']);
});
