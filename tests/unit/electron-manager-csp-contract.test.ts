import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(projectRoot, path), 'utf8');
}

function assertOnlySelfHostedExternalScripts(html: string, surface: string): void {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    assert.ok(scripts.length > 0, `${surface} HTML must load scripts`);

    for (const [, attributes, body] of scripts) {
        const src = attributes.match(/\bsrc=(['"])(.*?)\1/i)?.[2];
        assert.equal(body.trim(), '', `${surface} HTML must not include inline script bodies`);
        assert.ok(src?.startsWith('/') && !src.startsWith('//'), `${surface} scripts must be self-hosted`);
    }
}

test('manager HTML is compatible with Electron script-src self CSP', () => {
    const html = read('public/manager/index.html');

    assertOnlySelfHostedExternalScripts(html, 'manager');
    assert.ok(html.includes('src="/manager/theme-boot.js"'), 'manager HTML must load theme boot as a self-hosted script');
    assert.equal(existsSync(join(projectRoot, 'public/manager/theme-boot.js')), true);
});

test('dashboard2 HTML is compatible with Electron script-src self CSP', () => {
    const html = read('public/dashboard2/index.html');
    const themeModuleIndex = html.indexOf('src="/dashboard2/src/theme-bootstrap.ts"');
    const appModuleIndex = html.indexOf('src="/dashboard2/src/main.tsx"');

    assertOnlySelfHostedExternalScripts(html, 'dashboard2');
    assert.ok(themeModuleIndex >= 0, 'dashboard2 must load the self-hosted theme bootstrap module');
    assert.ok(themeModuleIndex < appModuleIndex, 'theme bootstrap must load before the application module');
    assert.equal(existsSync(join(projectRoot, 'public/dashboard2/src/theme-bootstrap.ts')), true);
});

test('manager preview avoids Electron-only iframe console errors', () => {
    const preview = read('public/manager/src/InstancePreview.tsx');

    assert.ok(preview.includes('loadedSrcRef'), 'theme sync must wait until the iframe loaded the current src');
    assert.ok(preview.includes('loadedSrcRef.current !== state.src'), 'theme sync must not post to initial about:blank');
    assert.ok(preview.includes('allow-popups-to-escape-sandbox'), 'preview iframe target=_blank links must open outside the sandboxed iframe');
    assert.equal(preview.includes('web-share'), false, 'Electron does not recognize web-share in iframe allow policy');
});
