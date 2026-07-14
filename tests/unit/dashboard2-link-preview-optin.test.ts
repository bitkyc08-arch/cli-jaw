import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { defaultDashboardRegistry, patchDashboardRegistry } from '../../src/manager/registry.js';
import { readSource } from './source-normalize.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string) => readSource(join(root, path), 'utf8');

test('link previews default off and normalize non-booleans to false', () => {
    assert.equal(defaultDashboardRegistry().ui.chatLinkPreviewsEnabled, false);
    const path = join(mkdtempSync(join(tmpdir(), 'jaw-link-preview-')), 'registry.json');
    const invalid = patchDashboardRegistry({ ui: { chatLinkPreviewsEnabled: 'yes' as unknown as boolean } }, { path });
    assert.equal(invalid.registry.ui.chatLinkPreviewsEnabled, false);
    const enabled = patchDashboardRegistry({ ui: { chatLinkPreviewsEnabled: true } }, { path });
    assert.equal(enabled.registry.ui.chatLinkPreviewsEnabled, true);
    assert.equal(enabled.registry.ui.locale, 'ko', 'unrelated registry fields survive the round trip');
});

test('provider and preview layer retain opt-in resource gates', () => {
    const provider = read('public/dashboard2/src/providers/preferences-provider.tsx');
    const preview = read('public/dashboard2/src/turn-stream/render/links/LinkPreviewCard.tsx');
    assert.ok(provider.indexOf('if (!hydratedRef.current)') < provider.indexOf('client.patch(patch)'));
    assert.match(provider, /chatLinkPreviewsEnabled:\s*enabled/);
    assert.match(preview, /if \(!enabled \|\| !host\) return/);
    assert.match(preview, /rootMargin:\s*'160px'/);
    assert.match(preview, /observer\.disconnect\(\)/);
    assert.match(preview, /controllers\.forEach\(controller => controller\.abort\(\)\)/);
});
