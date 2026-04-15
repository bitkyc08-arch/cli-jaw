import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const gatewaySrc = fs.readFileSync(join(__dirname, '../../src/orchestrator/gateway.ts'), 'utf8');
const spawnSrc = fs.readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
const botSrc = fs.readFileSync(join(__dirname, '../../src/telegram/bot.ts'), 'utf8');

test('TQ-001: submitMessage metadata supports optional chatId', () => {
    assert.ok(
        gatewaySrc.includes("chatId?: string | number"),
        'submitMessage meta should include optional chatId',
    );
});

test('TQ-002: busy path forwards target+chatId+requestId into enqueueMessage', () => {
    const busyStart = gatewaySrc.indexOf('// ── busy');
    const busyEnd = gatewaySrc.indexOf('// ── idle');
    const busyBlock = gatewaySrc.slice(busyStart, busyEnd);
    assert.ok(
        busyBlock.includes('enqueueMessage(trimmed, meta.origin, { target: meta.target, chatId: meta.chatId, requestId })'),
        'busy path should enqueue with target+chatId+requestId metadata',
    );
});

test('TQ-003: orchestrate paths forward target+chatId+requestId for continue/reset/normal', () => {
    assert.ok(
        gatewaySrc.includes('orchestrateContinue({ origin: meta.origin, target: meta.target, chatId: meta.chatId, requestId, _skipInsert: true })'),
        'continue path should pass target+chatId+requestId + _skipInsert',
    );
    assert.ok(
        gatewaySrc.includes('orchestrateReset({ origin: meta.origin, target: meta.target, chatId: meta.chatId, requestId, _skipInsert: true })'),
        'reset path should pass target+chatId+requestId + _skipInsert',
    );
    assert.ok(
        gatewaySrc.includes('orchestrate(trimmed, { origin: meta.origin, target: meta.target, chatId: meta.chatId, requestId, _skipInsert: true })'),
        'normal path should pass target+chatId+requestId + _skipInsert',
    );
});

test('TQ-004: processQueue isolates queue by groupQueueKey', () => {
    const queueStart = spawnSrc.indexOf('export async function processQueue()');
    const queueBlock = spawnSrc.slice(queueStart, queueStart + 2400);
    assert.ok(
        queueBlock.includes('groupQueueKey(first.source, first.target)'),
        'processQueue should use groupQueueKey for group isolation',
    );
    assert.ok(
        queueBlock.includes('if (key === groupKey) batch.push(m)'),
        'processQueue should batch only same group',
    );
    assert.ok(
        queueBlock.includes('messageQueue.push(...remaining)'),
        'processQueue should keep non-matching groups in queue',
    );
});

test('TQ-005: processQueue uses batch head source/chatId (no last-item leakage)', () => {
    const queueStart = spawnSrc.indexOf('export async function processQueue()');
    const queueBlock = spawnSrc.slice(queueStart, queueStart + 2200);
    assert.ok(
        queueBlock.includes('batch[0]') && queueBlock.includes('source'),
        'source should come from batch head',
    );
    assert.ok(
        queueBlock.includes('batch[0]') && queueBlock.includes('chatId'),
        'chatId should come from batch head',
    );
    assert.ok(
        !queueBlock.includes('const source = batched[batched.length - 1].source'),
        'old last-item source selection should be removed',
    );
});

test('TQ-006: processQueue no longer emits duplicate new_message broadcast', () => {
    const queueStart = spawnSrc.indexOf('export async function processQueue()');
    const queueEnd = spawnSrc.indexOf('// ─── Helpers');
    const queueBlock = spawnSrc.slice(queueStart, queueEnd);
    const executableLines = queueBlock
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('//'));
    assert.ok(
        !executableLines.some(line => line.includes("broadcast('new_message'")),
        'processQueue should not re-broadcast new_message',
    );
});

test('TQ-006b: processQueue respects worker busy guards', () => {
    const queueStart = spawnSrc.indexOf('export async function processQueue()');
    const queueBlock = spawnSrc.slice(queueStart, queueStart + 800);
    assert.ok(queueBlock.includes('hasBlockingWorkers()'), 'processQueue should guard against active workers');
    assert.ok(queueBlock.includes('hasPendingWorkerReplays()'), 'processQueue should guard against pending worker replay');
});

test('TQ-007: tgOrchestrate passes chatId to submitMessage', () => {
    const fnStart = botSrc.indexOf('async function tgOrchestrate');
    const fnBlock = botSrc.slice(fnStart, fnStart + 900);
    assert.ok(
        fnBlock.includes('const chatId = ctx.chat?.id'),
        'tgOrchestrate should capture current chatId',
    );
    assert.ok(
        fnBlock.includes('submitMessage(prompt, { origin: \'telegram\', displayText: displayMsg, skipOrchestrate: true, chatId })'),
        'tgOrchestrate should pass chatId into submitMessage',
    );
});

test('TQ-008: queued telegram response filter uses requestId for isolation', () => {
    const fnStart = botSrc.indexOf('const queueHandler = (type: string, data: Record<string, any>) =>');
    const fnBlock = botSrc.slice(fnStart, fnStart + 600);
    assert.ok(
        fnBlock.includes('data.requestId === requestId'),
        'queued response should match by requestId',
    );
    assert.ok(
        !fnBlock.includes('!data.chatId || data.chatId === chatId'),
        'legacy loose chatId fallback should be removed',
    );
});
