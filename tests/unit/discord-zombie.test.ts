// Discord zombie dual-client prevention — contract tests
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';

const botSrc = fs.readFileSync(join(import.meta.dirname, '../../src/discord/bot.ts'), 'utf8');

test('DZ-001: initDiscord has dcInitLock mutex guard', () => {
    assert.ok(botSrc.includes('dcInitLock'), 'dcInitLock must exist');
    assert.ok(botSrc.includes('already in progress'), 'must warn on concurrent entry');
});

test('DZ-002: initDiscord wraps body in try/finally for lock release', () => {
    assert.ok(botSrc.includes('} finally { dcInitLock = false; }'),
        'initDiscord must release lock in finally');
});

test('DZ-003: shutdownDiscord waits after destroy failure', () => {
    const sdIdx = botSrc.indexOf('async function shutdownDiscord');
    assert.ok(sdIdx >= 0, 'shutdownDiscord must exist');
    // Sized to the function, not a byte count: the window used to be 600 chars
    // and silently stopped covering the destroy path as soon as shutdown grew a
    // waiter-cleanup preamble (#407).
    const block = botSrc.slice(sdIdx, botSrc.indexOf('\nexport ', sdIdx + 1));
    assert.ok(block.includes('await old.destroy()'), 'must call old.destroy()');
    assert.ok(block.includes('setTimeout(r, 2000)'), 'must wait 2s after destroy failure');
});

test('DZ-004: self-message filter exists', () => {
    assert.ok(botSrc.includes('msg.author.id === client.user?.id'),
        'must filter own messages to prevent echo loops');
});
