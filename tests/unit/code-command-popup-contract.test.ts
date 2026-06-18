import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeStrictPropertyAccess } from './source-normalize.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..');

function read(path: string): string {
    return normalizeStrictPropertyAccess(readFileSync(join(root, path), 'utf8'));
}

test('code command popup routes popup commands through CodeCanvas state', () => {
    const canvas = read('public/manager/src/code/CodeCanvas.tsx');
    const composer = read('public/manager/src/code/CodeComposer.tsx');

    assert.ok(canvas.includes('activePopup'), 'CodeCanvas must own popup state');
    assert.ok(canvas.includes("command.actionType === 'popup' && command.popupKind"), 'popup commands must branch before text insertion');
    assert.ok(canvas.includes('setActivePopup({ kind: command.popupKind, command })'), 'popup branch must open popup state');
    assert.ok(canvas.includes('<CodeCommandPopup'), 'CodeCanvas must render the popup host');
    assert.ok(composer.includes('props.onCommandSelect(command)'), 'CodeComposer must remain a palette surface, not popup router');
});

test('code command popup exposes dialog and provider inventory states', () => {
    const popup = read('public/manager/src/code/CodeCommandPopup.tsx');
    const cssEntry = read('public/manager/src/code/code.css');

    assert.ok(popup.includes('role="dialog"'), 'popup must expose dialog semantics');
    assert.ok(popup.includes('aria-modal="true"'), 'popup must be modal to assistive tech');
    assert.ok(popup.includes("event.key === 'Escape'"), 'popup must close on Escape');
    assert.ok(popup.includes('modelOptions.providers.map'), 'provider popup must render returned provider inventory');
    assert.ok(popup.includes('modelOptions.degraded'), 'provider popup must explain degraded fallback');
    assert.ok(popup.includes('onRefreshProviders'), 'provider popup must expose refresh action');
    assert.ok(popup.includes('Provider add/login execution is next slice.'), 'provider popup must not overclaim add/login execution');
    assert.ok(cssEntry.includes("@import './code-command-popup.css';"), 'Code mode CSS entry must import popup CSS');
});

test('code command popup stays instance-independent', () => {
    const popup = read('public/manager/src/code/CodeCommandPopup.tsx');
    const canvas = read('public/manager/src/code/CodeCanvas.tsx');

    assert.equal(popup.includes('selectedInstance'), false, 'popup must not depend on manager instance selection');
    assert.equal(canvas.includes('selectedInstance'), false, 'CodeCanvas popup routing must remain instance-independent');
});
