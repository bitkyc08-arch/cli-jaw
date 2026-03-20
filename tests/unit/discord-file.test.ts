// Discord file handling tests — Phase 7 Bundle D
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const discordFileSrc = readFileSync(join(projectRoot, 'src/discord/discord-file.ts'), 'utf8');

// ─── File size guard ─────────────────────────────────

test('DISCORD_LIMITS defines 10 MiB cap', () => {
    assert.match(discordFileSrc, /10\s*\*\s*1024\s*\*\s*1024/,
        'should define 10 MiB limit');
});

test('validateDiscordFileSize throws on oversized files', () => {
    assert.match(discordFileSrc, /exceeds Discord 10 MiB limit/,
        'should throw descriptive error for oversized files');
    assert.match(discordFileSrc, /statusCode:\s*413/,
        'should set statusCode 413');
});

// ─── Behavior test: validateDiscordFileSize ──────────

test('validateDiscordFileSize accepts files under limit', async () => {
    const { validateDiscordFileSize } = await import('../../src/discord/discord-file.js');
    // Should not throw for 1 MiB
    assert.doesNotThrow(() => validateDiscordFileSize('test.txt', 1024 * 1024));
});

test('validateDiscordFileSize rejects files over 10 MiB', async () => {
    const { validateDiscordFileSize } = await import('../../src/discord/discord-file.js');
    const overLimit = 11 * 1024 * 1024;
    assert.throws(() => validateDiscordFileSize('big.bin', overLimit), /exceeds Discord 10 MiB/);
});

test('validateDiscordFileSize accepts exactly 10 MiB', async () => {
    const { validateDiscordFileSize } = await import('../../src/discord/discord-file.js');
    const exactLimit = 10 * 1024 * 1024;
    assert.doesNotThrow(() => validateDiscordFileSize('exact.bin', exactLimit));
});

// ─── Text-based channel requirement ──────────────────

test('sendDiscordFile checks for text-based channel', () => {
    assert.match(discordFileSrc, /not text-based/,
        'should reject non-text channels');
});

// ─── File attachment format ──────────────────────────

test('sendDiscordFile uses attachment format with basename', () => {
    assert.match(discordFileSrc, /attachment:\s*filePath/,
        'should pass file path as attachment');
    assert.match(discordFileSrc, /basename\(filePath\)/,
        'should use basename for filename');
});
