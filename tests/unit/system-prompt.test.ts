// System prompt alignment tests — Phase 7 Bundle D
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const a1Src = readFileSync(join(projectRoot, 'src/prompt/templates/a1-system.md'), 'utf8');
const empSrc = readFileSync(join(projectRoot, 'src/prompt/templates/employee.md'), 'utf8');

// ─── Canonical send endpoint ─────────────────────────

test('system prompt references canonical /api/channel/send', () => {
    assert.ok(a1Src.includes('/api/channel/send'),
        'system prompt should reference canonical channel send endpoint');
});

test('employee prompt references canonical /api/channel/send', () => {
    assert.ok(empSrc.includes('/api/channel/send'),
        'employee prompt should reference canonical channel send endpoint');
});

// ─── Legacy endpoints documented ─────────────────────

test('system prompt documents legacy telegram and discord endpoints', () => {
    assert.ok(a1Src.includes('/api/telegram/send'),
        'should document legacy telegram endpoint');
    assert.ok(a1Src.includes('/api/discord/send'),
        'should document legacy discord endpoint');
});

test('employee prompt documents legacy endpoints', () => {
    assert.ok(empSrc.includes('/api/telegram/send'),
        'should document legacy telegram endpoint');
    assert.ok(empSrc.includes('/api/discord/send'),
        'should document legacy discord endpoint');
});

// ─── Discord degraded mode documented ────────────────

test('system prompt documents Discord degraded mode', () => {
    assert.ok(a1Src.includes('degraded'),
        'should mention degraded mode');
    assert.ok(a1Src.includes('MESSAGE_CONTENT') || a1Src.includes('message-content') || a1Src.includes('slash command'),
        'should explain degraded mode limitations');
});

test('system prompt mentions jaw doctor for Discord diagnosis', () => {
    assert.ok(a1Src.includes('jaw doctor'),
        'should reference jaw doctor for status checks');
});

// ─── Channel-generic delivery ────────────────────────

test('employee prompt describes channel-generic delivery', () => {
    assert.ok(empSrc.includes('active channel'),
        'should mention active channel for channel-generic delivery');
});

// ─── Active channel auto-selection ───────────────────

test('system prompt documents channel omission defaults to active', () => {
    assert.ok(a1Src.includes('active channel'),
        'should document that omitting channel uses active channel');
});
