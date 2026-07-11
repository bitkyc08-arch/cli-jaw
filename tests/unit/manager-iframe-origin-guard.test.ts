import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
    allowedPreviewMessageOrigins,
    isAllowedPreviewMessage,
} from '../../public/manager/src/preview-message-security.ts';
import type { DashboardScanResult } from '../../public/manager/src/types.ts';

function scanWithPreviews(): DashboardScanResult {
    return {
        manager: {
            proxy: {
                preview: {
                    instances: {
                        '3459': { status: 'ready', url: 'http://localhost:14591/' },
                        '3460': { status: 'unavailable', url: 'http://localhost:14592/' },
                    },
                },
            },
        },
    } as unknown as DashboardScanResult;
}

test('preview message allowlist contains only the manager and ready preview origins', () => {
    const origins = allowedPreviewMessageOrigins(scanWithPreviews(), 'http://127.0.0.1:3458/manager/');

    assert.deepEqual([...origins].sort(), [
        'http://127.0.0.1:14591',
        'http://127.0.0.1:3458',
    ]);
});

test('untrusted preview message origins are ignored', () => {
    const origins = allowedPreviewMessageOrigins(scanWithPreviews(), 'http://localhost:3458/manager/');
    let handled = 0;
    const handle = (event: Pick<MessageEvent, 'origin'>): void => {
        if (!isAllowedPreviewMessage(event, origins)) return;
        handled += 1;
    };

    handle({ origin: 'https://attacker.example' });
    handle({ origin: 'null' });
    assert.equal(handled, 0);

    handle({ origin: 'http://localhost:3458' });
    handle({ origin: 'http://localhost:14591' });
    assert.equal(handled, 2);
});

test('every manager window message listener has an origin guard', () => {
    const shortcut = readFileSync('public/manager/src/usePreviewShortcutMessages.ts', 'utf8');
    const stt = readFileSync('public/manager/src/usePreviewSttLifecycle.ts', 'utf8');
    const bridge = readFileSync('public/manager/src/sync/IframeBridge.tsx', 'utf8');
    const preview = readFileSync('public/manager/src/InstancePreview.tsx', 'utf8');

    assert.match(shortcut, /onPreviewShortcut[\s\S]*isAllowedPreviewMessage\(event, allowedOrigins\)/);
    assert.match(stt, /onPreviewSttLifecycle[\s\S]*isAllowedPreviewMessage\(event, allowedOrigins\)/);
    assert.match(bridge, /onMessage[\s\S]*isAllowedPreviewMessage\(event, props\.allowedOrigins\)/);
    assert.equal((preview.match(/addEventListener\('message'/g) || []).length, 6);
    assert.equal((preview.match(/previewFrameOriginMatches\(event\.origin/g) || []).length, 4);
    assert.equal((preview.match(/isExpectedPreviewMessage\(event/g) || []).length, 4);
    assert.equal((preview.match(/event\.source !== iframeRef\.current\?\.contentWindow/g) || []).length, 3);
    assert.match(preview, /event\.source !== targetWindow/);
});
