// ─── CLI completion visibility: capability override (260703 doc 30 §A2) ──
// An explicit per-command capability map wins over the interfaces array for
// completion/help visibility (same precedence as command-contract/catalog.ts);
// execution dispatch still gates on `interfaces` — /steer stays refused by
// executeCommand for iface 'cli' and is forwarded by the TUI intercept.

import test from 'node:test';
import assert from 'node:assert/strict';
import { getCompletionItems, executeCommand, parseCommand, COMMANDS } from '../../src/cli/commands.ts';

test('/steer surfaces in CLI completion via its explicit capability map', () => {
    const names = getCompletionItems('/', 'cli').map(i => i.name);
    assert.ok(names.includes('steer'), 'steer should appear in CLI completion');
    const prefixed = getCompletionItems('/ste', 'cli').map(i => i.name);
    assert.ok(prefixed.includes('steer'), 'steer should match the /ste prefix query');
});

test('/queue surfaces in CLI completion but stays hidden from web completion', () => {
    const cliNames = getCompletionItems('/', 'cli').map(i => i.name);
    assert.ok(cliNames.includes('queue'), 'queue should appear in CLI completion');
    const webNames = getCompletionItems('/', 'web').map(i => i.name);
    assert.ok(!webNames.includes('queue'), 'queue is TUI-only — web manages the queue via row buttons');
});

test('capability visibility does not leak: web completion still shows steer, telegram map intact', () => {
    const webNames = getCompletionItems('/', 'web').map(i => i.name);
    assert.ok(webNames.includes('steer'), 'steer must stay web-visible');
    const steer = COMMANDS.find(c => c.name === 'steer');
    assert.equal(steer?.capability?.['telegram'], 'full', 'telegram capability must stay full (CP-008)');
    assert.equal(steer?.capability?.['cmdline'], 'hidden');
});

test('executeCommand still refuses /steer on iface cli (process boundary intact)', async () => {
    const parsed = parseCommand('/steer do something');
    const result = await executeCommand(parsed, { interface: 'cli', locale: 'en' });
    assert.equal(result?.ok, false, 'local CLI execution must stay blocked — the TUI intercept forwards instead');
});

test('commands without an explicit capability map keep interfaces-derived visibility', () => {
    const cliNames = getCompletionItems('/', 'cli').map(i => i.name);
    assert.ok(cliNames.includes('help'), 'interfaces-derived visibility unchanged');
    assert.ok(!cliNames.includes('file'), 'hidden commands stay hidden');
});
