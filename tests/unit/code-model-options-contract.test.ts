import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildJwcModelOptions,
    filterJwcModelUsageOrder,
    JWC_MODEL_CACHE_SCHEMA_VERSION,
    readJwcModelCache,
} from '../../src/code-mode/model-options.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

test('code model options return authenticated providers without unauthenticated additions', () => {
    const options = buildJwcModelOptions(['cursor', 'xai']);

    assert.deepEqual(options.providers.map(provider => provider.id), ['cursor', 'xai']);
    assert.equal(options.defaultProvider, 'cursor');
    assert.equal(options.degraded, undefined);
    assert.equal(options.error, undefined);
});

test('code model options use top-level degraded fallback when auth discovery is empty', () => {
    const options = buildJwcModelOptions([]);

    assert.deepEqual(options.providers.map(provider => provider.id), ['anthropic']);
    assert.equal(options.defaultProvider, 'anthropic');
    assert.equal(options.degraded, true);
    assert.match(options.error ?? '', /No authenticated JWC providers/);
});

test('code model options preserve auth discovery errors on degraded fallback', () => {
    const options = buildJwcModelOptions([], 'auth storage unavailable');

    assert.deepEqual(options.providers.map(provider => provider.id), ['anthropic']);
    assert.equal(options.degraded, true);
    assert.equal(options.error, 'auth storage unavailable');
});

test('code model options prefer JWC model cache over static provider defaults', () => {
    const options = buildJwcModelOptions(
        ['cursor', 'xai'],
        undefined,
        'cursor/cursor-cache-b',
        ['cursor/cursor-cache-b', 'cursor/stale', 'xai/grok-cache-a'],
        new Map([
            ['cursor', ['cursor-cache-a', 'cursor-cache-b']],
            ['xai', ['grok-cache-a']],
        ]),
    );

    assert.deepEqual(options.providers.find(provider => provider.id === 'cursor')?.models, ['cursor-cache-b', 'cursor-cache-a']);
    assert.deepEqual(options.providers.find(provider => provider.id === 'xai')?.models, ['grok-cache-a']);
    assert.deepEqual(options.usageOrder, ['cursor/cursor-cache-b', 'xai/grok-cache-a']);
    assert.equal(options.defaultProvider, 'cursor');
    assert.equal(options.defaultModel, 'cursor-cache-b');
});

test('code model options keep static fallback for missing or empty cache rows', () => {
    const options = buildJwcModelOptions(
        ['cursor'],
        undefined,
        undefined,
        [],
        new Map([['cursor', []]]),
    );

    assert.deepEqual(options.providers[0]?.models.slice(0, 3), ['composer-2.5', 'claude-sonnet-4-6', 'gpt-5.4']);
    assert.equal(options.defaultProvider, 'cursor');
    assert.equal(options.defaultModel, 'composer-2.5');
});

test('code model usage order filters stale entries after catalog resolution', () => {
    const usageOrder = filterJwcModelUsageOrder(
        ['cursor/a', 'cursor/missing', 'xai/grok', 'cursor/a', 'anthropic/ghost'],
        [
            { id: 'cursor', models: ['a', 'b'] },
            { id: 'xai', models: ['grok'] },
        ],
    );

    assert.deepEqual(usageOrder, ['cursor/a', 'xai/grok']);
});

test('code model cache reader accepts only JWC schema version 3 rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-jaw-model-cache-'));
    const dbPath = join(dir, 'models.db');
    const db = new Database(dbPath);
    try {
        db.exec(`
            CREATE TABLE model_cache (
                provider_id TEXT PRIMARY KEY,
                version INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                authoritative INTEGER NOT NULL DEFAULT 0,
                static_fingerprint TEXT NOT NULL DEFAULT '',
                models TEXT NOT NULL
            )
        `);
        db.prepare('INSERT INTO model_cache (provider_id, version, updated_at, authoritative, static_fingerprint, models) VALUES (?, ?, ?, ?, ?, ?)').run(
            'cursor',
            JWC_MODEL_CACHE_SCHEMA_VERSION,
            Date.now(),
            1,
            '',
            JSON.stringify([{ id: 'cursor-live-a' }, { id: 'cursor-live-b' }, { id: 'cursor-live-a' }]),
        );
        db.prepare('INSERT INTO model_cache (provider_id, version, updated_at, authoritative, static_fingerprint, models) VALUES (?, ?, ?, ?, ?, ?)').run(
            'xai',
            JWC_MODEL_CACHE_SCHEMA_VERSION - 1,
            Date.now(),
            1,
            '',
            JSON.stringify([{ id: 'stale-schema-model' }]),
        );
        db.prepare('INSERT INTO model_cache (provider_id, version, updated_at, authoritative, static_fingerprint, models) VALUES (?, ?, ?, ?, ?, ?)').run(
            'broken',
            JWC_MODEL_CACHE_SCHEMA_VERSION,
            Date.now(),
            1,
            '',
            '{',
        );
    } finally {
        db.close();
    }

    try {
        const catalog = readJwcModelCache(dir);
        assert.deepEqual(catalog.get('cursor'), ['cursor-live-a', 'cursor-live-b']);
        assert.equal(catalog.has('xai'), false);
        assert.equal(catalog.has('broken'), false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
