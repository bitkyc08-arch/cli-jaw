// ── SSE staleness watchdog contracts ──
// EventSource only reconnects on onerror; a silently dead socket never fires
// it. Server pings became data events; the client force-reconnects when pings
// stop — but only on ping-capable servers (old servers ping via comments).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const routeSrc = readFileSync(join(__dirname, '../../src/routes/events.ts'), 'utf8');
const channelSrc = readFileSync(join(__dirname, '../../public/js/event-channel.ts'), 'utf8');

test('SWD-001: server heartbeat is a data event, id-less', () => {
    assert.ok(routeSrc.includes(`JSON.stringify({ topic: 'system', event: 'ping' })`),
        'keep-alive must be observable by client JS (comments are invisible)');
    assert.ok(!routeSrc.includes("': ping\\n\\n'"), 'the old comment ping must be gone');
    const hbBlock = routeSrc.slice(routeSrc.indexOf('const hb = setInterval'), routeSrc.indexOf('hb.unref()'));
    assert.ok(!hbBlock.includes('id:'), 'pings must not advance lastEventId');
});

test('SWD-002: watchdog arms only after the first ping (old-server compat)', () => {
    assert.ok(channelSrc.includes('pingCapable = true'), 'first data ping marks the server liveness-capable');
    const wd = channelSrc.slice(channelSrc.indexOf('function armStallWatchdog('), channelSrc.indexOf('export function connectEventChannel('));
    assert.ok(wd.includes('!pingCapable) return'),
        'a server that never sent a data ping must not trigger reconnect churn on idle channels');
});

test('SWD-003: every message refreshes the liveness clock; pings are not dispatched', () => {
    const onMsg = channelSrc.slice(channelSrc.indexOf('source.onmessage'), channelSrc.indexOf('export function closeEventChannel('));
    assert.ok(onMsg.includes('lastMessageAt = Date.now()'), 'any traffic counts as liveness');
    const pingIdx = onMsg.indexOf("data['event'] === 'ping'");
    assert.ok(pingIdx >= 0 && pingIdx < onMsg.indexOf('dispatch('),
        'pings must be swallowed before subscriber dispatch');
});

test('SWD-004: a stalled channel force-reconnects through the normal drop path', () => {
    const wd = channelSrc.slice(channelSrc.indexOf('function armStallWatchdog('), channelSrc.indexOf('export function connectEventChannel('));
    assert.ok(wd.includes('Date.now() - lastMessageAt <= PING_STALL_MS) return'), 'healthy channels must not reconnect');
    assert.ok(wd.includes('onDisconnectCb?.()'), 'the UI must see the drop (reconnect indicator + replay on reopen)');
    assert.ok(wd.includes('connectEventChannel(currentLang)'), 'reconnect must reuse the lastEventId replay path');
});

test('SWD-005: closeEventChannel clears the watchdog timer', () => {
    const closeBlock = channelSrc.slice(channelSrc.indexOf('export function closeEventChannel('));
    assert.ok(closeBlock.includes('clearInterval(stallTimer)'), 'no orphaned interval after app close (260613 04 §3)');
});
