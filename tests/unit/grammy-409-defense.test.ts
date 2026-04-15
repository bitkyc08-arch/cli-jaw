// Grammy 409 defense — regression tests
// Validates initTelegram async signature, shutdown handler, and bot.start() catch behavior

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BOT_PATH = new URL('../../src/telegram/bot.ts', import.meta.url).pathname;
const SERVER_PATH = new URL('../../server.ts', import.meta.url).pathname;
const botSrc = fs.readFileSync(BOT_PATH, 'utf8');
const serverSrc = fs.readFileSync(SERVER_PATH, 'utf8');

// ─── bot.ts ──────────────────────────────────────────

test('initTelegram is async function', () => {
    assert.match(botSrc, /export\s+async\s+function\s+initTelegram/,
        'initTelegram must be async to await old.stop()');
});

test('initTelegram awaits old bot stop', () => {
    assert.match(botSrc, /await\s+old\.stop\s*\(\)/,
        'old.stop() must be awaited to prevent polling race');
});

test('bot.start() has .catch() for 409 handling', () => {
    assert.match(botSrc, /bot\.start\([\s\S]*?\)\.catch\(/,
        'bot.start() must have .catch() to handle 409 GrammyError');
});

test('409 retry uses tgRetryTimer for dedup', () => {
    assert.match(botSrc, /tgRetryTimer/,
        'tgRetryTimer variable must exist for retry deduplication');
    // Ensure timer is checked before setting
    assert.match(botSrc, /if\s*\(\s*!tgRetryTimer\s*\)/,
        'retry must check !tgRetryTimer before creating new timer');
});

test('409 retry calls void initTelegram()', () => {
    assert.match(botSrc, /void\s+initTelegram\s*\(\)/,
        'retry must use void initTelegram() for fire-and-forget');
});

// ─── server.ts ───────────────────────────────────────

test('shutdown handler uses shutdownMessagingRuntime', () => {
    assert.match(serverSrc, /shutdownMessagingRuntime\s*\(\)/,
        'shutdown handler must call shutdownMessagingRuntime()');
});

test('shutdown handler uses process.once and Promise.race', () => {
    assert.match(serverSrc, /process\.once\('SIGTERM',\s*\(\)\s*=>\s*shutdown\('SIGTERM'\)\)/,
        '서버 shutdown 핸들러가 process.once로 등록되어야 함');

    assert.match(serverSrc, /process\.once\('SIGINT',\s*\(\)\s*=>\s*shutdown\('SIGINT'\)\)/,
        '서버 shutdown 핸들러가 process.once로 등록되어야 함');

    // Messaging shutdown + timeout race
    assert.match(serverSrc, /Promise\.race\(\[\s*\n?\s*shutdownMessagingRuntime\(\)/,
        'shutdown handler must use Promise.race to prevent hanging');
});

test('bootstrap calls initActiveMessagingRuntime with error handling', () => {
    const listenBlock = serverSrc.slice(serverSrc.indexOf('server.listen'));
    assert.ok(listenBlock.includes('initActiveMessagingRuntime()'),
        'bootstrap must call initActiveMessagingRuntime()');
    assert.ok(listenBlock.includes('.catch(') || listenBlock.includes('} catch'),
        'bootstrap must catch init errors');
});

test('applyRuntimeSettingsPatch calls restartMessagingRuntime (unified restart)', () => {
    const runtimeSettingsSrc = fs.readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '../../src/core/runtime-settings.ts'), 'utf8',
    );
    assert.match(runtimeSettingsSrc, /await\s+restartMessagingRuntime\s*\(/,
        'applyRuntimeSettingsPatch must await restartMessagingRuntime() for transactional settings+restart');
});
