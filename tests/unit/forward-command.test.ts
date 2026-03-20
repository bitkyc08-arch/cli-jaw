// Forward command tests — Phase 7 Bundle D
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const commandsSrc = readFileSync(join(projectRoot, 'src/cli/commands.ts'), 'utf8');
const discordCommandsSrc = readFileSync(join(projectRoot, 'src/discord/commands.ts'), 'utf8');

// ─── Forward command registered for Discord ──────────

test('/forward is available on Discord interface', () => {
    // Find the forward command definition
    const forwardLine = commandsSrc.match(/name:\s*'forward'.*interfaces:\s*\[([^\]]+)\]/);
    assert.ok(forwardLine, 'forward command should be defined');
    assert.ok(forwardLine![1].includes('discord'),
        'forward command should be available on discord interface');
});

test('/forward is in DISCORD_SLASH_COMMANDS', () => {
    assert.match(discordCommandsSrc, /DISCORD_SLASH_COMMANDS[\s\S]*?'forward'/,
        'forward should be in DISCORD_SLASH_COMMANDS list');
});

// ─── Forward command description ─────────────────────

test('forward command has description key', () => {
    assert.match(commandsSrc, /name:\s*'forward'.*descKey:\s*'cmd\.forward\.desc'/,
        'forward should have a description key');
});

test('forward command has Telegram description key', () => {
    assert.match(commandsSrc, /name:\s*'forward'.*tgDescKey:\s*'cmd\.forward\.tg_desc'/,
        'forward should have a Telegram description key');
});

// ─── Forward toggles forwardAll setting ──────────────

test('forward command is defined as on/off toggle', () => {
    const forwardDef = commandsSrc.match(/name:\s*'forward'[^}]+/);
    assert.ok(forwardDef, 'forward command definition exists');
    assert.ok(forwardDef![0].includes('on|off'),
        'forward command should accept on/off args');
});
