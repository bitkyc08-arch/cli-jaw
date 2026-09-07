// ─── /steer command dispatch path tests ──────────────
// Validates steerHandler logic and bot.ts special branch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const handlersPath = path.join(import.meta.dirname, '../../src/cli/handlers-runtime.ts');
const handlersSrc = fs.readFileSync(handlersPath, 'utf8');

const commandsPath = path.join(import.meta.dirname, '../../src/cli/commands.ts');
const commandsSrc = fs.readFileSync(commandsPath, 'utf8');

const botPath = path.join(import.meta.dirname, '../../src/telegram/bot.ts');
const botSrc = fs.readFileSync(botPath, 'utf8');

// ── STR-001: /steer is registered in COMMANDS with correct interfaces ──

test('STR-001: /steer registered in COMMANDS with web/telegram interfaces (not cli)', () => {
    // Must have steer in COMMANDS array
    assert.ok(commandsSrc.includes("name: 'steer'"), 'COMMANDS should have steer entry');
    // Must include web and telegram (not cli — CLI TUI runs in separate process)
    const steerMatch = commandsSrc.match(/name:\s*'steer'[^}]*interfaces:\s*\[([^\]]+)\]/);
    assert.ok(steerMatch, 'steer should have interfaces defined');
    const interfaces = steerMatch![1]!;
    assert.ok(!interfaces.includes("'cli'"), 'steer should NOT include cli interface (process boundary)');
    assert.ok(interfaces.includes("'web'"), 'steer should include web interface');
    assert.ok(interfaces.includes("'telegram'"), 'steer should include telegram interface');
});

// STR-002 is covered behaviorally by native-steer-handler.test.ts: actual
// fallback handlers hold main-wait/exit gates, preserve scope and submit once.

// ── STR-003: steerHandler returns 'steer' type only for telegram ──

test('STR-003: steerHandler returns steer type for telegram, success for web/cli', () => {
    const fnMatch = handlersSrc.match(/export async function steerHandler[\s\S]*?^}/m);
    assert.ok(fnMatch, 'steerHandler should exist');
    const body = fnMatch![0]!;

    // Telegram branch returns type: 'steer' with steerPrompt
    assert.ok(body.includes("type: 'steer'"), 'should have steer type for telegram');
    assert.ok(body.includes('steerPrompt'), 'should include steerPrompt for telegram');

    // Non-telegram branch calls submitMessage and returns type: 'success'
    assert.ok(body.includes('submitMessage'), 'should call submitMessage for web/cli');
    assert.ok(body.includes("type: 'success'"), 'should return success type for web/cli');
});

// ── STR-004: steerHandler checks for empty prompt ──

test('STR-004: steerHandler validates prompt is not empty', () => {
    const fnMatch = handlersSrc.match(/export async function steerHandler[\s\S]*?^}/m);
    assert.ok(fnMatch, 'steerHandler should exist');
    const body = fnMatch![0]!;

    // Must check for empty prompt before killing
    const promptCheck = body.indexOf('noPrompt');
    const killCall = body.indexOf("killActiveAgent");
    assert.ok(promptCheck > 0, 'should check for empty prompt');
    assert.ok(killCall > promptCheck, 'kill should come after prompt validation');
});

// ── STR-005: steerHandler checks for no active agent ──

test('STR-005: steerHandler returns error when no agent running', () => {
    const fnMatch = handlersSrc.match(/export async function steerHandler[\s\S]*?^}/m);
    assert.ok(fnMatch, 'steerHandler should exist');
    const body = fnMatch![0]!;

    assert.ok(body.includes('noAgent'), 'should have noAgent error path');
    assert.ok(body.includes('isAgentBusy'), 'should check isAgentBusy (429 retry-aware)');
});

// ── STR-006: bot.ts steer branch does NOT call steerAgent ──

test('STR-006: bot.ts steer branch does not call steerAgent (no double orchestration)', () => {
    // Find the steer special branch in bot.ts
    const steerBranch = botSrc.match(/\/steer special path[\s\S]*?return;\s*\}/);
    assert.ok(steerBranch, 'bot.ts should have /steer special branch');
    const branch = steerBranch![0]!;

    // Must NOT call steerAgent (handler already killed the agent)
    assert.ok(!branch.includes('steerAgent'), 'steer branch should NOT call steerAgent — handler already killed');

    // Must call tgOrchestrate
    assert.ok(branch.includes('tgOrchestrate'), 'steer branch should call tgOrchestrate');
});

// ── STR-007: steerHandler import is in commands.ts ──

test('STR-007: steerHandler is imported in commands.ts', () => {
    assert.ok(commandsSrc.includes('steerHandler'), 'commands.ts should import steerHandler');
});

// ── STR-008: i18n keys exist for steer command ──

test('STR-008: i18n keys exist for steer command in ko.json and en.json', () => {
    const koPath = path.join(import.meta.dirname, '../../public/locales/ko.json');
    const enPath = path.join(import.meta.dirname, '../../public/locales/en.json');
    const ko = JSON.parse(fs.readFileSync(koPath, 'utf8'));
    const en = JSON.parse(fs.readFileSync(enPath, 'utf8'));

    for (const key of ['cmd.steer.desc', 'cmd.steer.noPrompt', 'cmd.steer.noAgent', 'cmd.steer.started']) {
        assert.ok(ko[key], `ko.json should have ${key}`);
        assert.ok(en[key], `en.json should have ${key}`);
    }
});
