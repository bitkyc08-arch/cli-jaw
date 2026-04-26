import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const uiSrc = readFileSync(join(root, 'public/js/ui.ts'), 'utf8');
const wsSrc = readFileSync(join(root, 'public/js/ws.ts'), 'utf8');
const chatCss = readFileSync(join(root, 'public/css/chat.css'), 'utf8');

function exportedFunctionBlock(source: string, name: string): string {
    const start = source.indexOf(`export function ${name}`);
    assert.ok(start >= 0, `${name} should be exported`);
    const tail = source.slice(start);
    const next = tail.slice(1).search(/\nexport function /);
    return next >= 0 ? tail.slice(0, next + 1) : tail;
}

test('ui exposes restore indicator lifecycle helpers', () => {
    assert.ok(uiSrc.includes('export function showChatRestoreIndicator'));
    assert.ok(uiSrc.includes('export function hideChatRestoreIndicator'));
    assert.ok(uiSrc.includes('export function hideChatRestoreIndicatorAfterSettle'));
    assert.ok(uiSrc.includes('const RESTORE_INDICATOR_SETTLE_MS = 1100'));
    assert.ok(uiSrc.includes('let chatRestoreIndicatorHideTimer'));
});

test('restore indicator is chat-level and idempotent', () => {
    const showBlock = exportedFunctionBlock(uiSrc, 'showChatRestoreIndicator');
    assert.ok(showBlock.includes("document.querySelector('.chat-area')"), 'indicator should be anchored at chat viewport level');
    assert.ok(showBlock.includes('data-restore-indicator="true"'), 'indicator should use a stable data marker');
    assert.ok(showBlock.includes('chatRestoreIndicatorHideTimer'), 'show should clear pending hide timers');
    assert.ok(!showBlock.includes('.process-block'), 'indicator should not be inserted inside process rows');
    assert.ok(!showBlock.includes('.process-details'), 'indicator should not be inserted inside process details');
    assert.ok(!showBlock.includes('.process-step'), 'indicator should not be inserted inside process steps');
});

test('restore indicator hide after settle resets one timer', () => {
    const hideBlock = exportedFunctionBlock(uiSrc, 'hideChatRestoreIndicatorAfterSettle');
    assert.ok(hideBlock.includes('window.clearTimeout(chatRestoreIndicatorHideTimer)'), 'hide scheduling should reset previous timers');
    assert.ok(hideBlock.includes('window.setTimeout'), 'hide scheduling should wait for restore settle');
    assert.ok(hideBlock.includes('hideChatRestoreIndicator()'), 'scheduled callback should delegate to the immediate hide helper');
});

test('bottom restore owns indicator lifecycle', () => {
    const restoreBlock = exportedFunctionBlock(uiSrc, 'reconcileChatBottomAfterRestore');
    assert.ok(restoreBlock.includes('showChatRestoreIndicator(reason)'), 'bottom restore should show the indicator');
    assert.ok(restoreBlock.includes('hideChatRestoreIndicatorAfterSettle()'), 'bottom restore should schedule settle hide');
    assert.ok(restoreBlock.includes('vs.forceBottomAfterRestore'), 'virtual-scroll restore path should remain intact');
    assert.ok(restoreBlock.includes('window.setTimeout(scroll, 250)'), 'non-VS 250ms pass should remain intact');
    assert.ok(restoreBlock.includes('window.setTimeout(scroll, 1000)'), 'non-VS 1000ms pass should remain intact');
});

test('ws restore hooks route through one wrapper and reconcile in finally', () => {
    assert.ok(wsSrc.includes('showChatRestoreIndicator'), 'ws should import/show the restore indicator before snapshot sync');
    assert.ok(wsSrc.includes('function syncAfterBrowserRestore(reason: string)'), 'ws should centralize browser restore handling');
    const wrapperStart = wsSrc.indexOf('function syncAfterBrowserRestore');
    const wrapperEnd = wsSrc.indexOf('function registerOrchestrateRestoreHooks', wrapperStart);
    const wrapper = wsSrc.slice(wrapperStart, wrapperEnd);
    assert.ok(wrapper.includes('showChatRestoreIndicator(reason)'), 'wrapper should show before sync');
    assert.ok(wrapper.includes('syncOrchestrateSnapshot(reason)'), 'wrapper should refresh snapshot');
    assert.ok(wrapper.includes('.finally(() =>'), 'wrapper should reconcile even when snapshot sync fails');
    assert.ok(wrapper.includes('reconcileChatBottomAfterRestore(reason)'), 'wrapper should trigger bottom restore after sync');
    assert.ok(wsSrc.includes("syncAfterBrowserRestore('focus')"));
    assert.ok(wsSrc.includes("syncAfterBrowserRestore('pageshow')"));
    assert.ok(wsSrc.includes("syncAfterBrowserRestore('visibilitychange')"));
    assert.ok(wsSrc.includes("syncAfterBrowserRestore('resume')"));
    assert.ok(wsSrc.includes("syncAfterBrowserRestore('discard')"));
});

test('restore indicator CSS does not block input', () => {
    assert.ok(chatCss.includes('.chat-restore-indicator'), 'chat restore indicator styles should exist');
    const start = chatCss.indexOf('.chat-restore-indicator');
    const block = chatCss.slice(start, chatCss.indexOf('}', start));
    assert.ok(block.includes('pointer-events: none'), 'restore indicator must not block scroll or pointer input');
    assert.ok(block.includes('position: absolute'), 'indicator should be viewport-level, not row-flow content');
});

