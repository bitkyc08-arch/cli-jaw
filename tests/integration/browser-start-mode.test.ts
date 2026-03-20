import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliBrowserSrc = fs.readFileSync(join(__dirname, '../../bin/commands/browser.ts'), 'utf8');
const routeBrowserSrc = fs.readFileSync(join(__dirname, '../../src/routes/browser.ts'), 'utf8');
const connectionSrc = fs.readFileSync(join(__dirname, '../../src/browser/connection.ts'), 'utf8');

test('BSM-001: CLI browser start exposes --agent option', () => {
    assert.match(cliBrowserSrc, /agent:\s*\{\s*type:\s*'boolean'/);
});

test('BSM-002: CLI browser start sends manual or agent mode to API', () => {
    assert.match(cliBrowserSrc, /mode:\s*values\.agent\s*\?\s*'agent'\s*:\s*'manual'/);
});

test('BSM-003: route resolves browser start options before launch', () => {
    assert.match(routeBrowserSrc, /resolveBrowserStartOptions/);
    assert.match(routeBrowserSrc, /normalizeBrowserStartMode/);
});

test('BSM-004: route rejects debug mode before launching Chrome', () => {
    assert.match(routeBrowserSrc, /start\.mode === 'debug'/);
    assert.match(routeBrowserSrc, /status\(400\)/);
});

test('BSM-005: connection delegates mode handling to launch policy', () => {
    assert.match(connectionSrc, /resolveLaunchPolicy/);
    assert.match(connectionSrc, /mode:\s*opts\.mode/);
});
