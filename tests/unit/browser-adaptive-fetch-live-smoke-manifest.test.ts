import test from 'node:test';
import assert from 'node:assert/strict';
import { getLiveSmokeManifest, LIVE_SMOKE_MANIFEST_VERSION } from '../../src/browser/adaptive-fetch/live-smoke-manifest.js';
import { validateFetchUrl } from '../../src/browser/adaptive-fetch/safety.js';

test('live smoke manifest is default-off data with public known URLs only', () => {
    const manifest = getLiveSmokeManifest();
    assert.equal(LIVE_SMOKE_MANIFEST_VERSION, 1);
    assert.ok(manifest.length >= 4);
    for (const entry of manifest) {
        const parsed = validateFetchUrl(entry.url, { allowPrivateNetwork: false });
        assert.equal(parsed.protocol, 'https:');
        assert.ok(entry.id);
        assert.ok(entry.reason);
        assert.ok(entry.expectedLabels.length > 0);
        assert.ok(entry.expectedEvidence.length > 0);
        assert.match(entry.browserMode, /^(auto|never|required)$/);
    }
});

test('live smoke manifest returns defensive copies', () => {
    const first = getLiveSmokeManifest();
    first[0]?.expectedLabels.push('mutated');
    const second = getLiveSmokeManifest();
    assert.ok(!second[0]?.expectedLabels.includes('mutated'));
});
