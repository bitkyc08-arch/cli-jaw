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

test('manager HTML is compatible with Electron script-src self CSP', () => {
    const html = read('public/manager/index.html');

    assert.equal(/<script>\s*\(/.test(html), false, 'manager HTML must not include inline boot scripts');
    assert.ok(html.includes('src="/manager/theme-boot.js"'), 'manager HTML must load theme boot as a self-hosted script');
    assert.equal(existsSync(join(projectRoot, 'public/manager/theme-boot.js')), true);
});

test('manager preview avoids Electron-only iframe console errors', () => {
    const preview = read('public/manager/src/InstancePreview.tsx');

    assert.ok(preview.includes('loadedSrcRef'), 'theme sync must wait until the iframe loaded the current src');
    assert.ok(preview.includes('loadedSrcRef.current !== state.src'), 'theme sync must not post to initial about:blank');
    assert.equal(preview.includes('web-share'), false, 'Electron does not recognize web-share in iframe allow policy');
});
