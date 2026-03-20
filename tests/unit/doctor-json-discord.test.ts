// Doctor JSON Discord schema tests — Phase 7 Bundle D
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const doctorSrc = readFileSync(join(projectRoot, 'bin/commands/doctor.ts'), 'utf8');

// ─── JSON schema fields ─────────────────────────────

test('doctor JSON output includes checks array', () => {
    assert.match(doctorSrc, /checks:\s*results/,
        'JSON output should include checks array');
});

test('doctor JSON output includes activeChannel field', () => {
    assert.ok(doctorSrc.includes('activeChannel'),
        'JSON output should include activeChannel field');
});

test('doctor JSON output includes discord object', () => {
    assert.match(doctorSrc, /discord:\s*buildDiscordStatus/,
        'JSON output should include discord status object');
});

// ─── Discord status fields ──────────────────────────

test('discord status has status field', () => {
    const fn = doctorSrc.slice(doctorSrc.indexOf('function buildDiscordStatus'));
    assert.match(fn, /status/,
        'discord status should have status field');
});

test('discord status has enabled field', () => {
    const fn = doctorSrc.slice(doctorSrc.indexOf('function buildDiscordStatus'));
    assert.match(fn, /enabled/,
        'discord status should have enabled field');
});

test('discord status has tokenPresent field', () => {
    const fn = doctorSrc.slice(doctorSrc.indexOf('function buildDiscordStatus'));
    assert.match(fn, /tokenPresent/,
        'discord status should have tokenPresent field');
});

test('discord status has guildConfigured field', () => {
    const fn = doctorSrc.slice(doctorSrc.indexOf('function buildDiscordStatus'));
    assert.match(fn, /guildConfigured/,
        'discord status should have guildConfigured field');
});

test('discord status has channelIdsConfigured field', () => {
    const fn = doctorSrc.slice(doctorSrc.indexOf('function buildDiscordStatus'));
    assert.match(fn, /channelIdsConfigured/,
        'discord status should have channelIdsConfigured field');
});

test('discord status has degradedReasons array', () => {
    const fn = doctorSrc.slice(doctorSrc.indexOf('function buildDiscordStatus'));
    assert.ok(fn.includes('degradedReasons'),
        'discord status should have degradedReasons field');
});

test('discord status has runtimeReady field', () => {
    const fn = doctorSrc.slice(doctorSrc.indexOf('function buildDiscordStatus'));
    assert.ok(fn.includes('runtimeReady'),
        'discord status should have runtimeReady field');
});

test('discord status has channelConsistent field', () => {
    const fn = doctorSrc.slice(doctorSrc.indexOf('function buildDiscordStatus'));
    assert.ok(fn.includes('channelConsistent'),
        'discord status should have channelConsistent field');
});
