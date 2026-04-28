import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliSrc = fs.readFileSync(join(root, 'bin/commands/browser.ts'), 'utf8');
const visionSrc = fs.readFileSync(join(root, 'src/browser/vision.ts'), 'utf8');
const routeSrc = fs.readFileSync(join(root, 'src/routes/browser.ts'), 'utf8');

test('VCO-001: vision-click uses parseArgs positionals so option values do not enter target', () => {
    const start = cliSrc.indexOf("case 'vision-click'");
    const end = cliSrc.indexOf("case 'navigate'", start);
    const block = cliSrc.slice(start, end);
    assert.match(block, /allowPositionals: true/);
    assert.match(block, /const target = positionals\.join\(' '\)/);
    assert.doesNotMatch(block, /filter\(a => !a\.startsWith\('--'\)\)\.join\(' '\)/);
});

test('VCO-002: vision-click exposes guardrail options', () => {
    for (const token of ['prepareStable', 'verifyBeforeClick', 'region', 'clip']) {
        assert.match(visionSrc, new RegExp(token));
    }
    assert.match(cliSrc, /'prepare-stable'/);
    assert.match(cliSrc, /'verify-before-click'/);
});

test('VCO-002b: route forwards vision-click guardrail options', () => {
    const start = routeSrc.indexOf("'/api/browser/vision-click'");
    const end = routeSrc.indexOf("app.post('/api/browser/navigate'", start);
    const block = routeSrc.slice(start, end);
    for (const token of ['prepareStable', 'region', 'clip', 'verifyBeforeClick']) {
        assert.match(block, new RegExp(token));
    }
});

test('VCO-003: vision-click region scope excludes right-panel in this slice', () => {
    assert.match(visionSrc, /'left-panel' \| 'center-map' \| 'top-bar'/);
    assert.doesNotMatch(visionSrc, /right-panel/);
});
