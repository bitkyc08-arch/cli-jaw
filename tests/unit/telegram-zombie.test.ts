// Telegram zombie polling prevention — contract tests
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';

const projectRoot = join(import.meta.dirname, '../..');
const botSrc = fs.readFileSync(join(projectRoot, 'src/telegram/bot.ts'), 'utf8');

test('TZ-001: initTelegram has tgInitLock mutex guard', () => {
    assert.ok(botSrc.includes('tgInitLock'), 'tgInitLock must exist');
    assert.ok(botSrc.includes('already in progress'), 'must warn on concurrent entry');
});

test('TZ-002: 409 retry uses exponential backoff', () => {
    assert.ok(botSrc.includes('Math.pow'), '409 retry must use exponential backoff');
    assert.ok(botSrc.includes('tg409RetryCount'), 'retry counter must exist');
});

test('TZ-003: 409 retry has max limit (TG_MAX_RETRIES)', () => {
    assert.ok(botSrc.includes('TG_MAX_RETRIES'), 'max retry constant must exist');
    assert.ok(botSrc.includes('Max retries'), 'must log when max retries exceeded');
});

test('TZ-004: old.stop() failure triggers wait before proceeding', () => {
    const initIdx = botSrc.indexOf('_initTelegramInner');
    assert.ok(initIdx >= 0, '_initTelegramInner must exist');
    // Anchored on the declaration rather than the first textual mention: the
    // shared dispose helper (added with the queue-notice registry, #413) now
    // references _initTelegramInner in its own doc comment, so indexOf lands
    // above the function and a fixed window never reaches the stop path.
    const declIdx = botSrc.indexOf('async function _initTelegramInner');
    assert.ok(declIdx >= 0, '_initTelegramInner declaration must exist');
    const initBlock = botSrc.slice(declIdx, declIdx + 1600);
    assert.ok(initBlock.includes('await old.stop()'), 'initTelegramInner must call old.stop()');
    assert.ok(initBlock.includes('setTimeout(r, 2000)'), 'must wait 2s after stop failure');
});

test('TZ-005: deleteWebhook called before polling via durable poller', () => {
    // wp9 moved deleteWebhook into TelegramDurablePoller.bootstrapInner()
    // (update-offset.ts) where it runs before the first getUpdates call.
    const pollerSrc = fs.readFileSync(join(projectRoot, 'src/telegram/update-offset.ts'), 'utf8');
    assert.ok(pollerSrc.includes('deleteWebhook'), 'deleteWebhook must exist in the durable poller');
    // Find the method IMPLEMENTATION (not the type/call site) by looking for
    // the method signature with its parameter list.
    const implIdx = pollerSrc.indexOf('bootstrapInner(signal: AbortSignal)');
    assert.ok(implIdx >= 0, 'bootstrapInner implementation must exist');
    const implBlock = pollerSrc.slice(implIdx, implIdx + 600);
    const delInImpl = implBlock.indexOf('deleteWebhook');
    const getUpdInImpl = implBlock.indexOf('getUpdates');
    assert.ok(delInImpl >= 0, 'deleteWebhook must be in bootstrapInner');
    assert.ok(delInImpl < getUpdInImpl, 'deleteWebhook must come before getUpdates');
});

test('TZ-006: onStart resets tg409RetryCount', () => {
    const onStartIdx = botSrc.indexOf('onStart:');
    assert.ok(onStartIdx >= 0, 'onStart callback must exist');
    const block = botSrc.slice(onStartIdx, onStartIdx + 200);
    assert.ok(block.includes('tg409RetryCount = 0'), 'onStart must reset retry counter');
});
