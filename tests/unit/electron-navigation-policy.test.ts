import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildManagerCsp,
    buildPreviewFrameOrigins,
    externalOpenUrlForNavigation,
    isAppInternalNavigation,
    isManagerNavigation,
    isPreviewFrameNavigation,
    normalizeExternalOpenUrl,
    resolvePreviewFramePolicy,
} from '../../electron/src/main/lib/navigation-policy.ts';

function parseCspDirectives(csp: string): Array<{ name: string; sources: string[] }> {
    return csp
        .split(';')
        .map((directive) => directive.trim())
        .filter(Boolean)
        .map((directive) => {
            const [name, ...sources] = directive.split(/\s+/);
            return { name, sources };
        });
}

function assertExactSelfScriptSrc(csp: string): void {
    const scriptDirectives = parseCspDirectives(csp)
        .filter((directive) => directive.name === 'script-src');

    assert.equal(scriptDirectives.length, 1, 'CSP must define exactly one script-src directive');
    const sources = scriptDirectives[0].sources;
    assert.deepEqual(sources, ["'self'"], "script-src must contain exactly 'self'");
    assert.equal(sources.some((source) => source === "'unsafe-inline'"), false);
    assert.equal(sources.some((source) => source === "'unsafe-eval'"), false);
    assert.equal(sources.some((source) => /^'nonce-/i.test(source)), false);
    assert.equal(sources.some((source) => /^'sha(?:256|384|512)-/i.test(source)), false);
    assert.equal(sources.some((source) => source.includes('*')), false);
}

test('electron CSP allows loopback origin-port iframe previews', () => {
    const policy = { previewFrom: 24602, previewCount: 2 };
    const origins = buildPreviewFrameOrigins(policy);
    const csp = buildManagerCsp('http://127.0.0.1:24576', origins);

    assert.ok(csp.includes('frame-src'));
    assert.ok(csp.includes('child-src'));
    assertExactSelfScriptSrc(csp);
    assert.ok(csp.includes("'self'"));
    assert.ok(csp.includes('http:'));
    assert.ok(csp.includes('https:'));
    assert.ok(csp.includes('http://127.0.0.1:24602'));
    assert.ok(csp.includes('http://localhost:24603'));
    assert.equal(csp.includes('http://example.com'), false);
});

test('electron CSP contract rejects unsafe script-src allowances', () => {
    const forbiddenSources = [
        "'unsafe-inline'",
        "'unsafe-eval'",
        "'nonce-dashboard2'",
        "'sha256-dashboard2'",
        '*',
        'https://*.example.com',
    ];

    for (const source of forbiddenSources) {
        assert.throws(
            () => assertExactSelfScriptSrc(`default-src 'self'; script-src 'self' ${source}`),
            undefined,
            `script-src must reject ${source}`,
        );
    }
});

test('electron frame navigation allows only manager or configured loopback preview ports', () => {
    const policy = { previewFrom: 24602, previewCount: 50 };

    assert.equal(isManagerNavigation('http://127.0.0.1:24576/', 'http://127.0.0.1:24576'), true);
    assert.equal(isManagerNavigation('http://127.0.0.1:24577/dashboard2/projects/demo', 'http://127.0.0.1:24577'), true);
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

test('electron external open policy keeps app origins internal and opens safe web URLs', () => {
    const options = {
        managerOrigin: 'http://127.0.0.1:24576',
        previewFrom: 24602,
        previewCount: 50,
    };

    assert.equal(normalizeExternalOpenUrl('https://example.com/docs'), 'https://example.com/docs');
    assert.equal(normalizeExternalOpenUrl('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000/');
    assert.equal(normalizeExternalOpenUrl('javascript:alert(1)'), null);
    assert.equal(normalizeExternalOpenUrl('https://user:pass@example.com/'), null);
    assert.equal(isAppInternalNavigation('http://127.0.0.1:24576/manager', options), true);
    assert.equal(isAppInternalNavigation('http://127.0.0.1:24602/', options), true);
    assert.equal(externalOpenUrlForNavigation('http://127.0.0.1:24576/manager', options), null);
    assert.equal(externalOpenUrlForNavigation('http://127.0.0.1:24602/', options), null);
    assert.equal(externalOpenUrlForNavigation('https://github.com/lidge-jun/cli-jaw', options), 'https://github.com/lidge-jun/cli-jaw');
    assert.equal(externalOpenUrlForNavigation('http://127.0.0.1:3000/', options), 'http://127.0.0.1:3000/');
});
