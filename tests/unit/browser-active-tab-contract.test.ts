import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const connectionSrc = fs.readFileSync(join(root, 'src/browser/connection.ts'), 'utf8');
const routesSrc = fs.readFileSync(join(root, 'src/routes/browser.ts'), 'utf8');
const cliSrc = fs.readFileSync(join(root, 'bin/commands/browser.ts'), 'utf8');

test('BAT-001: active tab contract exposes stable JSON fields', () => {
    assert.match(connectionSrc, /interface BrowserTabInfo/);
    for (const field of ['tabId', 'targetId', 'index', 'title', 'url', 'active', 'attached']) {
        assert.match(connectionSrc, new RegExp(`${field}:`));
    }
});

test('BAT-002: active-tab fails closed for no or ambiguous active target', () => {
    assert.match(connectionSrc, /interface ActiveTabResult/);
    assert.match(connectionSrc, /reason\?: 'none' \| 'ambiguous' \| 'unverified' \| 'not-found'/);
    assert.match(connectionSrc, /active\.length !== 1|active\.length === 0/);
});

test('BAT-002b: active-tab resolution does not use getActivePage array-order fallback', () => {
    const start = connectionSrc.indexOf('async function resolveActiveTargetId');
    const end = connectionSrc.indexOf('export async function listTabs', start);
    const block = connectionSrc.slice(start, end);
    assert.doesNotMatch(block, /getActivePage/);
    assert.doesNotMatch(block, /pages\.length - 1/);
});

test('BAT-003: tab-switch verifies target and invalidates browser state', () => {
    assert.match(connectionSrc, /export async function switchTab/);
    assert.match(connectionSrc, /bringToFront\(\)/);
    assert.match(connectionSrc, /markBrowserStateChanged\(\)/);
    assert.match(routesSrc, /\/api\/browser\/tab-switch', requireAuth/);
});

test('BAT-004: CLI exposes tabs json, active-tab, and tab-switch', () => {
    assert.match(cliSrc, /case 'tabs'/);
    assert.match(cliSrc, /--json/);
    assert.match(cliSrc, /case 'active-tab'/);
    assert.match(cliSrc, /case 'tab-switch'/);
});
