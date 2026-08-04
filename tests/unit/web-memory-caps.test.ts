// ── Client memory cap contracts (devlog 260613 docs 06/50 phase 5b) ──
// Long-lived tabs (manager iframe, days of uptime) must not grow without
// bound: history window, preview cache LRU, IDB stale scopes, listener guards.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(__dirname, '../..', p), 'utf8');

test('WMC-001: chat history boots with a recent-window, not full history', () => {
    const src = read('public/js/features/message-history.ts');
    assert.match(src, /BOOT_MESSAGE_WINDOW = 3000/, 'window must be bounded (server caps at 5000)');
    // Phase 071 wraps the boot query with the viewed session id, so the literal
    // return is now withCurrentSessionQuery(`?limit=...`). The invariant under
    // test is unchanged: the boot request must carry the bounded window.
    assert.match(src, /return withCurrentSessionQuery\(`\?limit=\$\{BOOT_MESSAGE_WINDOW\}`\)|return `\?limit=\$\{BOOT_MESSAGE_WINDOW\}`/,
        'bootMessageQuery must request the window — items[].html was the largest client allocation');
});

test('WMC-002: link-preview cache is LRU-capped with observer disconnect', () => {
    const src = read('public/js/render/link-preview.ts');
    assert.match(src, /MAX_PREVIEW_CACHE = 200/);
    assert.ok(src.includes('previewCache.delete(url);') && src.includes('// LRU touch'), 'hits must refresh recency');
    assert.ok(src.includes('observer.disconnect()'), 'per-anchor observers must fully disconnect');
});

test('WMC-003: IDB sweeps stale non-current scopes once per session', () => {
    const src = read('public/js/features/idb-cache.ts');
    assert.match(src, /STALE_SCOPE_MAX_AGE_MS = 30 \* 24/);
    assert.ok(src.includes('staleScopeSweepDone'), 'sweep must run at most once per page session');
    assert.ok(src.includes("!== currentScope) cursor.delete()"), 'only non-current scopes are swept');
});

test('WMC-004: document/window-level listeners are init-guarded', () => {
    for (const [file, flag] of [
        ['public/js/features/media-lightbox.ts', 'lightboxInitialized'],
        ['public/js/features/chat-search.ts', 'chatSearchInitialized'],
        ['public/js/features/settings-mcp.ts', 'mcpModalInitialized'],
    ] as const) {
        assert.ok(read(file).includes(flag), `${file} must guard against re-init listener stacking`);
    }
});
