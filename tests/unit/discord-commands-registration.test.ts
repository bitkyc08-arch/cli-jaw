// Discord slash command registration tests — Phase 7 Bundle D
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const commandsSrc = readFileSync(join(projectRoot, 'src/discord/commands.ts'), 'utf8');

// ─── DISCORD_SLASH_COMMANDS list ────────────────────

test('DISCORD_SLASH_COMMANDS includes operational commands', () => {
    const listMatch = commandsSrc.match(/DISCORD_SLASH_COMMANDS\s*=\s*\[([\s\S]*?)\]/);
    assert.ok(listMatch, 'should define DISCORD_SLASH_COMMANDS array');
    const list = listMatch![1];
    for (const cmd of ['help', 'status', 'model', 'cli', 'forward', 'flush', 'version', 'steer']) {
        assert.ok(list.includes(`'${cmd}'`), `should include '${cmd}'`);
    }
});

// ─── Registration guard ─────────────────────────────

test('registerDiscordSlashCommands guards on guildId', () => {
    assert.match(commandsSrc, /guildId.*not set.*skipping/,
        'should skip registration when guildId is not set');
});

test('registerDiscordSlashCommands guards on application id', () => {
    assert.match(commandsSrc, /application.*id.*not available/,
        'should skip when application id is not available');
});

// ─── Command builder ────────────────────────────────

test('slash commands are built with SlashCommandBuilder', () => {
    assert.match(commandsSrc, /new SlashCommandBuilder/,
        'should use SlashCommandBuilder');
    assert.match(commandsSrc, /setName\(name\)/,
        'should set command name');
    assert.match(commandsSrc, /addStringOption/,
        'should add args string option');
});

// ─── Guild-scoped registration ──────────────────────

test('commands are registered as guild-scoped (not global)', () => {
    assert.match(commandsSrc, /applicationGuildCommands/,
        'should use applicationGuildCommands for guild-scoped registration');
});

// ─── Command execution uses parseCommand ────────────

test('slash command handler uses parseCommand + executeCommand', () => {
    assert.match(commandsSrc, /parseCommand/,
        'should use parseCommand for slash interaction');
    assert.match(commandsSrc, /executeCommand/,
        'should use executeCommand for slash interaction');
});

// ─── applySettings uses applyRuntimeSettingsPatch ───

test('discord command context uses applyRuntimeSettingsPatch', () => {
    assert.match(commandsSrc, /applyRuntimeSettingsPatch/,
        'should use transactional settings patch');
});
