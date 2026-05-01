import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildManagerCsp,
    buildPreviewFrameOrigins,
    isManagerNavigation,
    isPreviewFrameNavigation,
    resolvePreviewFramePolicy,
} from '../../electron/src/main/lib/navigation-policy.ts';

test('electron CSP allows loopback origin-port iframe previews', () => {
    const policy = { previewFrom: 24602, previewCount: 2 };
    const origins = buildPreviewFrameOrigins(policy);
    const csp = buildManagerCsp('http://127.0.0.1:24576', origins);

    assert.ok(csp.includes('frame-src'));
    assert.ok(csp.includes("script-src 'self'"));
    assert.ok(csp.includes("'self'"));
    assert.ok(csp.includes('http://127.0.0.1:24602'));
    assert.ok(csp.includes('http://localhost:24603'));
    assert.equal(csp.includes("script-src 'self' 'unsafe-inline'"), false);
    assert.equal(csp.includes('http://example.com'), false);
});

test('electron frame navigation allows only manager or configured loopback preview ports', () => {
    const policy = { previewFrom: 24602, previewCount: 50 };

    assert.equal(isManagerNavigation('http://127.0.0.1:24576/', 'http://127.0.0.1:24576'), true);
    assert.equal(isPreviewFrameNavigation('http://127.0.0.1:24602/', policy), true);
    assert.equal(isPreviewFrameNavigation('http://localhost:24651/', policy), true);
    assert.equal(isPreviewFrameNavigation('http://127.0.0.1:24652/', policy), false);
    assert.equal(isPreviewFrameNavigation('https://127.0.0.1:24602/', policy), false);
    assert.equal(isPreviewFrameNavigation('http://example.com:24602/', policy), false);
});

test('electron preview frame policy follows dashboard preview env with capped count', () => {
    const policy = resolvePreviewFramePolicy({
        DASHBOARD_PREVIEW_FROM: '25000',
        DASHBOARD_SCAN_COUNT: '999',
    });

    assert.deepEqual(policy, { previewFrom: 25000, previewCount: 200 });
});
