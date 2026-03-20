// Discord forwarder tests — Phase 6 Bundle A
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const forwarderSrc = readFileSync(join(projectRoot, 'src/discord/forwarder.ts'), 'utf8');
const botSrc = readFileSync(join(projectRoot, 'src/discord/bot.ts'), 'utf8');

// ─── chunkDiscordMessage ────────────────────────────

test('chunkDiscordMessage splits at 2000 char limit', async () => {
    const { chunkDiscordMessage } = await import('../../src/discord/forwarder.js');
    const short = 'hello world';
    assert.deepEqual(chunkDiscordMessage(short), [short]);

    const long = 'a'.repeat(2001);
    const chunks = chunkDiscordMessage(long);
    assert.ok(chunks.length > 1, 'should split long message');
    assert.ok(chunks.every(c => c.length <= 2000), 'each chunk must be ≤ 2000');
});

test('chunkDiscordMessage prefers splitting at newlines', async () => {
    const { chunkDiscordMessage } = await import('../../src/discord/forwarder.js');
    const lineA = 'a'.repeat(1500);
    const lineB = 'b'.repeat(600);
    const text = `${lineA}\n${lineB}`;
    const chunks = chunkDiscordMessage(text);
    assert.equal(chunks[0], lineA, 'first chunk should split at newline');
});

// ─── Forwarder skip logic ──────────────────────────

test('forwarder skips origin=discord to prevent echo loop', () => {
    assert.match(forwarderSrc, /shouldSkip/,
        'forwarder should have shouldSkip callback');
    assert.match(botSrc, /data\.origin\s*===\s*['"]discord['"]/,
        'bot should skip discord-origin messages in forwarder');
});

// ─── Reply path: dcOrchestrate passes chatId ────────

test('dcOrchestrate passes chatId to submitMessage', () => {
    assert.match(botSrc, /chatId.*msg\.channelId/,
        'dcOrchestrate should pass chatId from msg.channelId');
});

test('queue handler correlates by requestId for request-level isolation', () => {
    assert.match(botSrc, /data\.requestId\s*===\s*requestId/,
        'queue handler should correlate by requestId');
    assert.ok(!botSrc.includes('data.target?.targetId === msg.channelId'),
        'queue handler should NOT use data.target?.targetId (not always present)');
});

// ─── orchestrateAndCollect receives chatId ──────────

test('orchestrateAndCollect call includes chatId', () => {
    const collectCall = botSrc.match(/orchestrateAndCollect\(prompt,[\s\S]*?\)/);
    assert.ok(collectCall, 'should call orchestrateAndCollect');
    assert.match(collectCall![0], /chatId/,
        'orchestrateAndCollect call should include chatId');
});
