import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parseCommand,
    executeCommand,
    getCompletions,
    getCompletionItems,
    getArgumentCompletionItems,
    COMMANDS,
} from '../../src/commands.js';

// ─── parseCommand ────────────────────────────────────

test('parseCommand: non-slash input returns null', () => {
    assert.equal(parseCommand('hello'), null);
    assert.equal(parseCommand(''), null);
    assert.equal(parseCommand(123), null);
});

test('parseCommand: bare "/" returns help command', () => {
    const r = parseCommand('/');
    assert.equal(r.type, 'known');
    assert.equal(r.name, 'help');
    assert.deepEqual(r.args, []);
});

test('parseCommand: known command is parsed correctly', () => {
    const r = parseCommand('/model gpt-5.3-codex');
    assert.equal(r.type, 'known');
    assert.equal(r.cmd.name, 'model');
    assert.deepEqual(r.args, ['gpt-5.3-codex']);
});

test('parseCommand: command aliases work', () => {
    const r = parseCommand('/h');
    assert.equal(r.type, 'known');
    assert.equal(r.cmd.name, 'help');
});

test('parseCommand: unknown command returns type unknown', () => {
    const r = parseCommand('/nonexistent');
    assert.equal(r.type, 'unknown');
    assert.equal(r.name, 'nonexistent');
});

test('parseCommand: multi-word args are split', () => {
    const r = parseCommand('/fallback claude codex gemini');
    assert.equal(r.type, 'known');
    assert.deepEqual(r.args, ['claude', 'codex', 'gemini']);
});

// ─── executeCommand ──────────────────────────────────

test('executeCommand: null parsed returns null', async () => {
    const r = await executeCommand(null, {});
    assert.equal(r, null);
});

test('executeCommand: unknown command returns error result', async () => {
    const r = await executeCommand({ type: 'unknown', name: 'foo', args: [] }, {});
    assert.equal(r.ok, false);
    assert.equal(r.code, 'unknown_command');
});

test('executeCommand: /quit returns exit code', async () => {
    const parsed = parseCommand('/quit');
    const r = await executeCommand(parsed, { interface: 'cli' });
    assert.equal(r.ok, true);
    assert.equal(r.code, 'exit');
});

test('executeCommand: /clear returns clear_screen for cli', async () => {
    const parsed = parseCommand('/clear');
    const r = await executeCommand(parsed, { interface: 'cli' });
    assert.equal(r.ok, true);
    assert.equal(r.code, 'clear_screen');
});

test('executeCommand: /clear returns info for telegram', async () => {
    const parsed = parseCommand('/clear');
    const r = await executeCommand(parsed, { interface: 'telegram' });
    assert.equal(r.ok, true);
    assert.ok(r.text.includes('Telegram'));
});

test('executeCommand: unsupported interface returns error', async () => {
    // /memory is cli-only
    const parsed = parseCommand('/memory');
    const r = await executeCommand(parsed, { interface: 'web' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'unsupported_interface');
});

test('executeCommand: handler error is caught gracefully', async () => {
    const parsed = parseCommand('/status');
    // status handler calls ctx.getSettings etc — passing empty ctx will throw
    const r = await executeCommand(parsed, {});
    assert.equal(r.ok, true); // still succeeds because safeCall handles nulls
});

// ─── getCompletions / getCompletionItems ─────────────

test('getCompletions: empty partial returns all cli commands', () => {
    const list = getCompletions('', 'cli');
    assert.ok(list.length > 0);
    assert.ok(list.every(c => c.startsWith('/')));
    assert.ok(list.includes('/help'));
    assert.ok(list.includes('/status'));
});

test('getCompletions: partial filters results', () => {
    const list = getCompletions('/mod', 'cli');
    assert.ok(list.includes('/model'));
    assert.ok(!list.includes('/help'));
});

test('getCompletionItems returns structured objects', () => {
    const items = getCompletionItems('/ver', 'cli');
    assert.ok(items.length >= 1);
    const ver = items.find(i => i.name === 'version');
    assert.ok(ver);
    assert.equal(ver.kind, 'command');
    assert.ok(ver.insertText.startsWith('/version'));
});

test('getCompletions: telegram interface excludes cli-only commands', () => {
    const list = getCompletions('', 'telegram');
    // /memory is cli-only
    assert.ok(!list.includes('/memory'));
    // /help is available everywhere
    assert.ok(list.includes('/help'));
});

// ─── getArgumentCompletionItems ──────────────────────

test('getArgumentCompletionItems: cli command returns cli choices', () => {
    const items = getArgumentCompletionItems('cli', '', 'cli', [], {});
    assert.ok(items.length > 0);
    assert.ok(items.every(i => i.kind === 'argument'));
});

test('getArgumentCompletionItems: unknown command returns empty', () => {
    const items = getArgumentCompletionItems('nonexistent', '', 'cli');
    assert.deepEqual(items, []);
});

// ─── COMMANDS registry integrity ─────────────────────

test('COMMANDS: every command has required fields', () => {
    for (const cmd of COMMANDS) {
        assert.equal(typeof cmd.name, 'string', `command missing name`);
        assert.equal(typeof cmd.desc, 'string', `${cmd.name} missing desc`);
        assert.ok(Array.isArray(cmd.interfaces), `${cmd.name} missing interfaces`);
        assert.equal(typeof cmd.handler, 'function', `${cmd.name} missing handler`);
    }
});

test('COMMANDS: no duplicate names', () => {
    const names = COMMANDS.map(c => c.name);
    assert.equal(names.length, new Set(names).size);
});
