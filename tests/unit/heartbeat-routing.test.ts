// Heartbeat routing tests — Phase 6 Bundle C
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const heartbeatSrc = readFileSync(join(projectRoot, 'src/memory/heartbeat.ts'), 'utf8');
const sendSrc = readFileSync(join(projectRoot, 'src/messaging/send.ts'), 'utf8');

// ─── Heartbeat send failure surfacing ──────────────

test('heartbeat checks sendChannelOutput result', () => {
    assert.match(heartbeatSrc, /sendResult\.ok/,
        'heartbeat must check sendChannelOutput result.ok');
    assert.match(heartbeatSrc, /send failed/,
        'heartbeat must log send failure');
});

// ─── Canonical send fallback chain ──────────────────

test('sendChannelOutput has configured fallback after lastActive/latestSeen', () => {
    assert.match(sendSrc, /getConfiguredFallbackTarget/,
        'should have getConfiguredFallbackTarget function');
    assert.match(sendSrc, /channelIds/,
        'discord fallback should use channelIds');
    assert.match(sendSrc, /allowedChatIds/,
        'telegram fallback should use allowedChatIds');
});

test('sendChannelOutput returns explicit error when no target available', () => {
    assert.match(sendSrc, /No target available/,
        'should return explicit error when no target is available');
});

// ─── Target resolution order ────────────────────────

test('target resolution follows explicit > lastActive > latestSeen > configured', () => {
    // The sendChannelOutput function should check in this order
    const sendFn = sendSrc.slice(sendSrc.indexOf('async function sendChannelOutput'));
    const lastActiveIdx = sendFn.indexOf('getLastActiveTarget');
    const latestSeenIdx = sendFn.indexOf('getLatestSeenTarget');
    const configuredIdx = sendFn.indexOf('getConfiguredFallbackTarget');

    assert.ok(lastActiveIdx < latestSeenIdx, 'lastActive before latestSeen');
    assert.ok(latestSeenIdx < configuredIdx, 'latestSeen before configured');
});
