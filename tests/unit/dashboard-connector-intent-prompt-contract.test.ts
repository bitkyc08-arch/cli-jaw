// Contract test: A1 carries the dashboard-connector-intent anchor and the
// prompt builder is wired to safe-append the anchor for users with edited
// A-1.md files. Matches devlog/_fin/260511_dashboard_agent_workspace/03_phase3_prompt_intent_guard.md.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const A1_PATH = path.resolve(here, '..', '..', 'src', 'prompt', 'templates', 'a1-system.md');
const BUILDER_PATH = path.resolve(here, '..', '..', 'src', 'prompt', 'builder.ts');

function readA1(): string {
    return fs.readFileSync(A1_PATH, 'utf8');
}

function readBuilder(): string {
    return fs.readFileSync(BUILDER_PATH, 'utf8');
}

test('A1 carries dashboard-connector-intent anchor pair', () => {
    const a1 = readA1();
    assert.match(a1, /<!-- anchor:dashboard-connector-intent -->/);
    assert.match(a1, /<!-- \/anchor:dashboard-connector-intent -->/);
});

test('A1 dashboard connector block separates GitHub from Dashboard wording', () => {
    const a1 = readA1();
    const open = a1.indexOf('<!-- anchor:dashboard-connector-intent -->');
    const close = a1.indexOf('<!-- /anchor:dashboard-connector-intent -->');
    assert.ok(open >= 0 && close > open, 'anchor block must exist');
    const block = a1.slice(open, close);
    assert.match(block, /GitHub/);
    assert.match(block, /Dashboard Board/);
    assert.match(block, /Dashboard Reminders/);
    assert.match(block, /Dashboard Notes/);
    assert.match(block, /PR|pull request|#123/);
});

test('A1 dashboard connector block states on-demand-only contract', () => {
    const a1 = readA1();
    const open = a1.indexOf('<!-- anchor:dashboard-connector-intent -->');
    const close = a1.indexOf('<!-- /anchor:dashboard-connector-intent -->');
    const block = a1.slice(open, close);
    assert.match(block, /on-demand/);
    assert.match(block, /Never create, update, move, or display/);
    assert.match(block, /userRequested:\s*true/);
});

test('A1 dashboard connector block requires clarification for ambiguous wording', () => {
    const a1 = readA1();
    const open = a1.indexOf('<!-- anchor:dashboard-connector-intent -->');
    const close = a1.indexOf('<!-- /anchor:dashboard-connector-intent -->');
    const block = a1.slice(open, close);
    assert.match(block, /ambiguous/);
    assert.match(block, /one clarification question/);
});

test('builder.ts declares dashboard-connector anchor constants', () => {
    const b = readBuilder();
    assert.match(b, /DASHBOARD_CONNECTOR_ANCHOR_OPEN\s*=\s*'<!-- anchor:dashboard-connector-intent -->'/);
    assert.match(b, /DASHBOARD_CONNECTOR_ANCHOR_CLOSE\s*=\s*'<!-- \/anchor:dashboard-connector-intent -->'/);
});

test('builder.ts ensureDashboardConnectorAnchor is invoked from the user-edits append path', () => {
    const b = readBuilder();
    assert.match(b, /function ensureDashboardConnectorAnchor\(/);
    assert.match(b, /ensureDashboardConnectorAnchor\(userText, a1Content\)/);
    assert.match(b, /appended dashboard-connector-intent anchor/);
});
