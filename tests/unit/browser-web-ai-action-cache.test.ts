import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    cacheKey,
    createActionCacheHandle,
    getCachedTarget,
    loadActionCache,
    saveActionCache,
    updateCacheEntry,
} from '../../src/browser/web-ai/action-cache.ts';
import { CACHE_SCHEMA_VERSION } from '../../src/browser/web-ai/constants.ts';

test('action cache stores versioned selector targets by provider and fingerprint', () => {
    const cache = loadActionCache(join(tmpdir(), `missing-${Date.now()}`));
    updateCacheEntry(
        cache,
        { provider: 'chatgpt', intent: 'composer.fill', actionKind: 'fill', urlHost: 'chatgpt.com' },
        { selector: '#prompt-textarea', role: 'textbox', name: 'Message ChatGPT' },
        { domHashPrefix: 'dom-a', axHashPrefix: 'ax-a' },
    );

    const hit = getCachedTarget(cache, {
        provider: 'chatgpt',
        intent: 'composer.fill',
        actionKind: 'fill',
        urlHost: 'chatgpt.com',
        fingerprint: { domHashPrefix: 'dom-a', axHashPrefix: 'ax-a' },
    });

    assert.equal(cache.schemaVersion, CACHE_SCHEMA_VERSION);
    assert.equal(hit?.target.selector, '#prompt-textarea');
    assert.equal(hit?.target.schemaVersion, CACHE_SCHEMA_VERSION);
    assert.match(hit?.entry.target.signatureHash || '', /^sha256:/);
});

test('action cache handle persists and reloads raw cache', () => {
    const home = mkdtempSync(join(tmpdir(), 'web-ai-action-cache-'));
    try {
        const handle = createActionCacheHandle(home);
        handle.update(
            { provider: 'gemini', intent: 'upload.click', actionKind: 'click', urlHost: 'gemini.google.com' },
            { selector: '[aria-label="Upload"]', role: 'button', name: 'Upload' },
            { domHashPrefix: 'dom-b' },
        );
        handle.save();

        const key = cacheKey({
            provider: 'gemini',
            urlHost: 'gemini.google.com',
            intent: 'upload.click',
            actionKind: 'click',
            domHashPrefix: 'dom-b',
        });
        const reloaded = loadActionCache(home);
        assert.equal(reloaded.entries[key]?.target.selector, '[aria-label="Upload"]');
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});
