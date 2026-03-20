// Doctor Discord degraded matrix tests — Phase 7 Bundle D
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const doctorSrc = readFileSync(join(projectRoot, 'bin/commands/doctor.ts'), 'utf8');

// ─── Active channel display ─────────────────────────

test('doctor shows active channel', () => {
    assert.match(doctorSrc, /Active channel/,
        'doctor should display the active channel');
});

// ─── Discord check exists ───────────────────────────

test('doctor has Discord check', () => {
    assert.match(doctorSrc, /check\('Discord'/,
        'doctor should have a Discord check');
});

// ─── Discord status matrix ──────────────────────────

test('doctor detects Discord disabled', () => {
    assert.match(doctorSrc, /discord\?\.enabled/,
        'should check if Discord is enabled');
});

test('doctor detects missing Discord token', () => {
    assert.match(doctorSrc, /token missing/,
        'should report missing token');
});

test('doctor detects missing guild ID', () => {
    assert.match(doctorSrc, /guild ID missing/,
        'should report missing guild ID');
});

test('doctor detects missing channel IDs', () => {
    assert.match(doctorSrc, /channel IDs missing/,
        'should report missing channel IDs');
});

// ─── JSON output includes Discord schema ─────────────

test('doctor --json includes activeChannel', () => {
    assert.match(doctorSrc, /activeChannel/,
        'JSON output should include activeChannel');
});

test('doctor --json includes discord status object', () => {
    assert.match(doctorSrc, /buildDiscordStatus/,
        'JSON output should include discord status');
});

// ─── Discord status builder ─────────────────────────

test('buildDiscordStatus returns degradedReasons array', () => {
    assert.match(doctorSrc, /degradedReasons/,
        'status builder should return degradedReasons');
});

test('buildDiscordStatus distinguishes missing_token vs missing_guild_id vs missing_channel_ids', () => {
    assert.match(doctorSrc, /missing_token/,
        'should have missing_token status');
    assert.match(doctorSrc, /missing_guild_id/,
        'should have missing_guild_id status');
    assert.match(doctorSrc, /missing_channel_ids/,
        'should have missing_channel_ids status');
});
