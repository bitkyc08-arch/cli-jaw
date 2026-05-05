import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const actionsSrc = fs.readFileSync(join(root, 'src/browser/actions.ts'), 'utf8');
const routesSrc = fs.readFileSync(join(root, 'src/routes/browser.ts'), 'utf8');
const cliSrc = fs.readFileSync(join(root, 'bin/commands/browser.ts'), 'utf8');

test('BOP-001: snapshot supports maxNodes/json and occurrence-safe refs', () => {
    assert.match(actionsSrc, /optionNumber\(opts, 'maxNodes'/);
    assert.match(actionsSrc, /optionNumber\(opts, 'max-nodes'/);
    assert.match(actionsSrc, /annotateOccurrences/);
    assert.match(actionsSrc, /occurrence/);
    assert.match(actionsSrc, /latestSnapshot/);
    assert.match(actionsSrc, /targetId: normalizeActiveTargetId\(activeTab\)/);
    assert.match(actionsSrc, /activeTargetId === latestSnapshot\.targetId/);
});

test('BOP-002: screenshot supports json and validated clip metadata', () => {
    assert.match(actionsSrc, /function normalizeClip/);
    assert.match(actionsSrc, /screenshot cannot combine ref and clip/);
    assert.match(cliSrc, /clip:\s*\{\s*type:\s*'string',\s*multiple:\s*true/);
    assert.match(cliSrc, /values\.json \? JSON\.stringify\(r/);
});

test('BOP-003: get-dom uses selector and maxChars contract', () => {
    assert.match(actionsSrc, /getDom\(port: number, opts/);
    assert.match(actionsSrc, /DEFAULT_DOM_MAX_CHARS/);
    assert.match(actionsSrc, /selector.*body/);
    assert.match(routesSrc, /\/api\/browser\/dom', requireAuth/);
});

test('BOP-004: wait primitives are authenticated routes and CLI commands', () => {
    assert.match(actionsSrc, /waitForSelector/);
    assert.match(actionsSrc, /waitForText/);
    assert.match(routesSrc, /\/api\/browser\/wait-for-selector', requireAuth/);
    assert.match(cliSrc, /case 'wait-for-text'/);
});

test('BOP-005: console and network are bounded and redacted', () => {
    assert.match(actionsSrc, /TOKEN_PATTERNS/);
    assert.match(actionsSrc, /redacted/);
    assert.match(actionsSrc, /query|hash|headers|cookies|bodies|parsed\.origin/);
    assert.match(routesSrc, /\/api\/browser\/network', requireAuth/);
});
