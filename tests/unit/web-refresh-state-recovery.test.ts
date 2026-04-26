import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wsPathTs = join(__dirname, '../../public/js/ws.ts');
const wsPathJs = join(__dirname, '../../public/js/ws.js');
const uiPathTs = join(__dirname, '../../public/js/ui.ts');
const uiPathJs = join(__dirname, '../../public/js/ui.js');
const virtualScrollPathTs = join(__dirname, '../../public/js/virtual-scroll.ts');
const virtualScrollPathJs = join(__dirname, '../../public/js/virtual-scroll.js');
const wsPath = existsSync(wsPathTs) ? wsPathTs : wsPathJs;
const uiPath = existsSync(uiPathTs) ? uiPathTs : uiPathJs;
const virtualScrollPath = existsSync(virtualScrollPathTs) ? virtualScrollPathTs : virtualScrollPathJs;
const hasWs = existsSync(wsPath);
const hasUi = existsSync(uiPath);
const hasVirtualScroll = existsSync(virtualScrollPath);

test('WRS-001: reconnect snapshot owns status instead of forced idle reset', { skip: !hasWs && 'public/js/ws source not found' }, () => {
    const wsSrc = readFileSync(wsPath, 'utf8');
    assert.ok(wsSrc.includes("syncOrchestrateSnapshot('reconnect', { hydrateRun: true })"), 'ws reconnect should hydrate runtime snapshot');
    assert.ok(!wsSrc.includes("m.setStatus('idle');"), 'ws reconnect should not force idle before snapshot');
});

test('WRS-002: queue updates rehydrate queued overlay from snapshot', { skip: !hasWs && 'public/js/ws source not found' }, () => {
    const wsSrc = readFileSync(wsPath, 'utf8');
    const queueBlock = wsSrc.slice(wsSrc.indexOf("msg.type === 'queue_update'"), wsSrc.indexOf("msg.type === 'worklog_created'"));
    assert.ok(queueBlock.includes("syncOrchestrateSnapshot('queue_update').catch"), 'queue updates should refresh snapshot state');
    assert.ok(queueBlock.includes('updateQueueBadge(msg.pending || 0)'), 'queue updates should still refresh badge count');
});

test('WRS-002b: browser restore hooks resync authoritative orchestration snapshot', { skip: !hasWs && 'public/js/ws source not found' }, () => {
    const wsSrc = readFileSync(wsPath, 'utf8');
    assert.ok(wsSrc.includes('function registerOrchestrateRestoreHooks'), 'ws should register orchestration restore hooks');
    assert.ok(wsSrc.includes('let snapshotSyncInFlight: Promise<void> | null = null'), 'snapshot sync should dedupe in-flight requests');
    assert.ok(wsSrc.includes('let lastSnapshotSyncAt = 0'), 'snapshot sync should track last sync timestamp');
    assert.ok(wsSrc.includes('const SNAPSHOT_SYNC_THROTTLE_MS = 750'), 'restore snapshot sync should have an explicit throttle window');
    assert.ok(wsSrc.includes('if (snapshotSyncInFlight) return snapshotSyncInFlight'), 'restore sync should reuse in-flight snapshot request');
    assert.ok(wsSrc.includes('now - lastSnapshotSyncAt < SNAPSHOT_SYNC_THROTTLE_MS'), 'restore sync should throttle rapid duplicate calls');
    assert.ok(wsSrc.includes('if (!options.hydrateRun)'), 'normal restore sync should be throttled separately from reconnect hydration');
    assert.ok(wsSrc.includes("window.addEventListener('focus'"), 'focus should trigger orchestrate snapshot sync');
    assert.ok(wsSrc.includes("window.addEventListener('pageshow'"), 'pageshow should trigger orchestrate snapshot sync');
    assert.ok(wsSrc.includes("document.addEventListener('visibilitychange'"), 'visibilitychange should trigger orchestrate snapshot sync');
    assert.ok(wsSrc.includes("syncOrchestrateSnapshot('focus')"), 'focus hook should call syncOrchestrateSnapshot');
    assert.ok(wsSrc.includes("syncOrchestrateSnapshot('pageshow')"), 'pageshow hook should call syncOrchestrateSnapshot');
    assert.ok(wsSrc.includes("syncOrchestrateSnapshot('visibilitychange')"), 'visibility hook should call syncOrchestrateSnapshot');
});

test('WRS-002c: orchestrate slash commands resync snapshot after command response', () => {
    const chatPath = existsSync(join(__dirname, '../../public/js/features/chat.ts'))
        ? join(__dirname, '../../public/js/features/chat.ts')
        : join(__dirname, '../../public/js/features/chat.js');
    const chatSrc = readFileSync(chatPath, 'utf8');
    assert.ok(chatSrc.includes("import { syncOrchestrateSnapshot } from '../ws.js'"), 'chat should import orchestrate snapshot sync');
    assert.ok(chatSrc.includes('function isOrchestrateCommand'), 'chat should classify orchestrate commands');
    assert.match(chatSrc, /\/\^\s*\\\/\(\?:orchestrate\|pabcd\)/, 'classifier should match both /orchestrate and /pabcd');
    assert.ok(chatSrc.includes('finally'), 'command path should sync after success and failure');
    assert.ok(chatSrc.includes("syncOrchestrateSnapshot('command')"), 'orchestrate commands should trigger snapshot sync');
});

test('WRS-003: hydrateActiveRun keeps live process block expanded', { skip: !hasUi && 'public/js/ui source not found' }, () => {
    const uiSrc = readFileSync(uiPath, 'utf8');
    const start = uiSrc.indexOf('export function hydrateActiveRun');
    const end = uiSrc.indexOf('export function appendAgentText');
    const hydrateBlock = uiSrc.slice(start, end);
    assert.ok(hydrateBlock.includes('hydrateStreamRenderer'), 'hydrateActiveRun should seed stream renderer state');
    assert.ok(!hydrateBlock.includes('collapseBlock('), 'hydrateActiveRun should not collapse in-flight process blocks');
});

test('WRS-004: applyQueuedOverlay no longer renders chat bubbles for queued items (pending-queue panel owns them)', { skip: !hasUi && 'public/js/ui source not found' }, () => {
    const uiSrc = readFileSync(uiPath, 'utf8');
    // New policy (Fix B4): queued items live exclusively in the pending-queue panel.
    // Chat bubble appears only when backend broadcasts new_message with fromQueue=true
    // (= the item actually started running). applyQueuedOverlay only cleans up legacy
    // overlay nodes from older builds during a soft reload.
    const fnIdx = uiSrc.indexOf('export function applyQueuedOverlay');
    assert.ok(fnIdx > 0, 'applyQueuedOverlay must still exist for legacy overlay cleanup');
    // Cap the inspected block at the next export so the next function's body doesn't leak in.
    const tail = uiSrc.slice(fnIdx);
    const nextExportRel = tail.slice(40).search(/\nexport (function|const|let|class)/);
    const fnBlock = nextExportRel > 0 ? tail.slice(0, nextExportRel + 40) : tail.slice(0, 1000);
    assert.ok(!fnBlock.includes('addMessage('), 'applyQueuedOverlay must NOT call addMessage — queued items live only in pending-queue panel');
    assert.ok(fnBlock.includes('data-queued-overlay="true"'), 'must still clean up legacy overlay nodes from older builds');
});

test('WRS-005: virtual scroll restore hooks preserve bottom intent after browser restore', { skip: !hasVirtualScroll && 'public/js/virtual-scroll source not found' }, () => {
    const src = readFileSync(virtualScrollPath, 'utf8');
    assert.ok(src.includes('isNearBottom('), 'VirtualScroll should expose near-bottom intent detection');
    assert.ok(src.includes('reconcileBottomAfterLayout('), 'VirtualScroll should expose post-layout bottom reconciliation');
    assert.ok(src.includes("window.addEventListener('pageshow'"), 'bfcache restore should be handled');
    assert.ok(src.includes("document.addEventListener('visibilitychange'"), 'sleep/wake visible restore should be handled');
    assert.ok(src.includes("window.addEventListener('focus'"), 'Chrome reopen/focus restore should be handled');
});

test('WRS-006: reconnect snapshot reapplies bottom anchor only when already following tail', { skip: !hasWs && 'public/js/ws source not found' }, () => {
    const wsSrc = readFileSync(wsPath, 'utf8');
    const openIdx = wsSrc.indexOf('state.ws.onopen');
    assert.ok(openIdx > 0, 'ws onopen handler should exist');
    const openBlock = wsSrc.slice(openIdx, wsSrc.indexOf('state.ws.onclose', openIdx));
    assert.ok(openBlock.includes('const shouldFollowBottom = isChatNearBottom()'), 'reconnect should capture bottom intent before hydration');
    assert.ok(openBlock.includes('reconcileChatBottomAfterLayout(shouldFollowBottom)'), 'reconnect should reconcile bottom after hydration');
});

test('WRS-007: ui exposes bottom intent helpers used by restore and reconnect paths', { skip: !hasUi && 'public/js/ui source not found' }, () => {
    const uiSrc = readFileSync(uiPath, 'utf8');
    assert.ok(uiSrc.includes('export function isChatNearBottom'), 'ui should export bottom intent reader');
    assert.ok(uiSrc.includes('export function reconcileChatBottomAfterLayout'), 'ui should export reconnect reconciliation helper');
    assert.ok(uiSrc.includes("vs.reconcileBottomAfterLayout('reconnect', true)"), 'virtual-scroll reconnect should use the same reconciliation path');
});
