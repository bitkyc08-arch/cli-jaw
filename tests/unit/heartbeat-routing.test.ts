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
//
// This used to assert the ORDER of three identifiers inside sendChannelOutput's
// source text. That is not a contract — it is a transcription of the current
// implementation, and it made the resolver un-refactorable while proving nothing
// about delivery. Worse, the file is named heartbeat-routing, so it read as an
// endorsement of the very fallback that misdelivered two scheduled reports on
// 2026-08-25 (#437).
//
// The behaviour it meant to protect now lives where it can actually fail:
//   tests/unit/send-validation.test.ts   — resolution order and the opt-out
//   tests/unit/heartbeat-runner-modes.test.ts — which request a job builds
