import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const wsSrc = readFileSync(join(root, 'public/js/ws.ts'), 'utf8');

function functionBlock(source: string, signature: string): string {
    const start = source.indexOf(signature);
    assert.ok(start >= 0, `${signature} should exist in ws.ts`);
    const tail = source.slice(start);
    const close = tail.indexOf('\n}\n');
    return close >= 0 ? tail.slice(0, close + 2) : tail;
}

test('ws-resume: restore trigger debounce exists without full history reload state', () => {
    assert.ok(wsSrc.includes('let lastRestoreTriggerAt = 0;'), 'restore trigger timestamp must exist');
    assert.ok(wsSrc.includes('const RESTORE_TRIGGER_DEBOUNCE_MS = 750;'), 'restore trigger debounce must be 750ms');
    assert.ok(!wsSrc.includes('lastHiddenAt'), 'hidden-duration heavy resume state must not exist');
    assert.ok(!wsSrc.includes('lastHeavyResumeAt'), 'heavy resume timestamp state must not exist');
    assert.ok(!wsSrc.includes('HEAVY_RESUME_HIDDEN_THRESHOLD_MS'), 'heavy resume threshold must not exist');
    assert.ok(!wsSrc.includes('HEAVY_RESUME_DEBOUNCE_MS'), 'heavy resume debounce must not exist');
});

test('ws-resume: restore sync hydrates runtime state but never reloads full message history', () => {
    const block = functionBlock(wsSrc, 'function syncAfterBrowserRestore(reason: string): void');
    assert.ok(block.includes('showChatRestoreIndicator(reason)'), 'indicator must show first');
    assert.ok(block.includes('syncOrchestrateSnapshot(reason, { hydrateRun: true })'), 'restore should hydrate active runtime only');
    assert.ok(block.includes('reconcileChatBottomAfterRestore(reason)'), 'restore should reconcile bottom');
    assert.ok(!block.includes('loadMessages'), 'restore path must not reload full /api/messages history');
});

test('ws-resume: requestBrowserRestoreSync debounces repeated restore triggers', () => {
    const block = functionBlock(wsSrc, 'function requestBrowserRestoreSync(reason: string): void');
    assert.ok(block.includes("reason !== 'discard'"), 'discard should bypass debounce');
    assert.ok(block.includes('RESTORE_TRIGGER_DEBOUNCE_MS'), 'must reference restore debounce constant');
    assert.ok(block.includes('lastRestoreTriggerAt = now;'), 'must stamp accepted restore trigger');
    assert.ok(block.includes('syncAfterBrowserRestore(reason)'), 'must call restore sync after debounce');
});

test('ws-resume: pageshow only restores for bfcache persisted events', () => {
    const start = wsSrc.indexOf("window.addEventListener('pageshow'");
    assert.ok(start >= 0, 'pageshow listener must exist');
    const tail = wsSrc.slice(start);
    const end = tail.indexOf('});');
    const handler = tail.slice(0, end + 3);
    assert.ok(handler.includes('event: PageTransitionEvent'), 'pageshow handler should type the event');
    assert.ok(handler.includes('if (!event.persisted) return;'), 'ordinary pageshow should not trigger restore');
    assert.ok(handler.includes("requestBrowserRestoreSync('pageshow')"), 'persisted pageshow should restore');
});

test('ws-resume: visibilitychange only restores on visible transition', () => {
    const start = wsSrc.indexOf("document.addEventListener('visibilitychange'");
    assert.ok(start >= 0, 'visibilitychange listener must exist');
    const tail = wsSrc.slice(start);
    const end = tail.indexOf('});');
    const handler = tail.slice(0, end + 3);
    assert.ok(handler.includes("document.visibilityState === 'visible'"), 'visible branch preserved');
    assert.ok(handler.includes("requestBrowserRestoreSync('visibilitychange')"), 'visible branch should request restore');
    assert.ok(!handler.includes("document.visibilityState === 'hidden'"), 'hidden branch should not track heavy reload state');
});
