import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const botSrc = readFileSync(join(projectRoot, 'src/discord/bot.ts'), 'utf8');
const spawnSrc = readFileSync(join(projectRoot, 'src/agent/spawn.ts'), 'utf8');

test('discord bot iterates all attachments instead of using first()', () => {
    assert.match(botSrc, /attachments\.values\(\)/,
        'bot should iterate over attachment values');
    assert.doesNotMatch(botSrc, /const first = msg\.attachments\.first\(\)!/,
        'bot should no longer collapse attachments to the first item');
});

test('discord bot uses Promise.allSettled for partial failure handling', () => {
    assert.match(botSrc, /Promise\.allSettled/,
        'bot should use Promise.allSettled for attachment downloads');
});

test('discord bot builds one multi-file prompt', () => {
    assert.match(botSrc, /buildMediaPromptMany/,
        'bot should use multi-file prompt helper');
});

test('spawn re-exports multi-file prompt helper', () => {
    assert.match(spawnSrc, /buildMediaPromptMany/,
        'spawn should re-export buildMediaPromptMany');
});
