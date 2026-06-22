// ── Dispatch transport hardening contracts (devlog 260613 docs 08/60) ──
// Root cause: `jaw dispatch` without --watch used blocking wait=true; undici's
// default 5-min headersTimeout killed the CLI ("fetch failed") while the
// worker kept running, and the orphaned result re-entered the conversation
// later as an unmarked pendingReplay turn. Polls also died on a single
// transient fetch error.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dispatchSrc = readFileSync(join(__dirname, '../../bin/commands/dispatch.ts'), 'utf8');
const serverSrc = readFileSync(join(__dirname, '../../server.ts'), 'utf8');
const pipelineSrc = readFileSync(join(__dirname, '../../src/orchestrator/pipeline.ts'), 'utf8');
const replayNoticeSrc = readFileSync(join(__dirname, '../../src/orchestrator/worker-replay-notice.ts'), 'utf8');
const configSrc = readFileSync(join(__dirname, '../../src/core/config.ts'), 'utf8');

test('DTH-001: dispatch always polls — no blocking wait past undici headersTimeout', () => {
    assert.ok(dispatchSrc.includes('wait: false,'), 'the POST must always request the 202 + poll mode');
    assert.ok(!dispatchSrc.includes('watch ? { wait: false }'), 'the watch-only conditional must be gone');
    const handler202 = dispatchSrc.slice(dispatchSrc.indexOf('if (res.status === 202) {'));
    assert.ok(handler202.includes('? await pollAndPrintWorker(') && handler202.includes(': await pollWorkerResult('),
        'both watch and quiet modes must resolve through polling');
});

test('DTH-002: poll fetches retry transient failures before DispatchPollError', () => {
    assert.match(dispatchSrc, /POLL_RETRY_DELAYS_MS = \[500, 1000, 2000\]/);
    assert.ok(dispatchSrc.includes('async function pollFetch('), 'shared retry helper should exist');
    const directCatches = dispatchSrc.match(/catch \(fetchErr\)/g) || [];
    assert.equal(directCatches.length, 1, 'only pollFetch may catch poll fetch errors (the three poll fns route through it)');
});

test('DTH-003: server keep-alive outlives pollers and worker polls skip the rate limiter', () => {
    assert.ok(serverSrc.includes('server.keepAliveTimeout = 65_000'), 'keepAlive must exceed poll intervals');
    assert.ok(serverSrc.includes('server.headersTimeout = 66_000'), 'headersTimeout must exceed keepAliveTimeout');
    assert.ok(serverSrc.includes("req.path.startsWith('/api/orchestrate/worker/')"),
        'bounded 2s dispatch polling must not consume the shared localhost bucket');
    assert.ok(serverSrc.includes("req.path.startsWith('/api/orchestrate/worker-progress')"),
        'progress polls share the exemption');
    assert.ok(!serverSrc.includes("req.path.startsWith('/api/orchestrate/worker')) return next()"),
        'the workers LIST endpoint must stay rate-limited (review #3)');
});

test('DTH-004: delayed worker replays carry an explicit marker', () => {
    assert.ok(pipelineSrc.includes('buildWorkerReplayNotice(pr)'),
        'late replay prompt text should be delegated to the bounded notice builder');
    assert.ok(replayNoticeSrc.includes('[worker-replay agent=${input.agentId}'),
        'late re-injections must be recognizable — the boss may have already compensated (doc 08 §2.3)');
    assert.ok(replayNoticeSrc.includes('run=${input.runId}'),
        'late re-injections must carry run identity for explicit recovery');
});

test('DTH-005: CLI base URL skips the dual-stack localhost lookup', () => {
    assert.ok(configSrc.includes('http://127.0.0.1:'), 'getServerUrl must use the IPv4 loopback literal');
    assert.ok(configSrc.includes('ws://127.0.0.1:'), 'getWsUrl stays consistent (review #5)');
});

test('DTH-006: poll result endpoint carries the orchestration verdict, stored before done', () => {
    const orchSrc = readFileSync(join(__dirname, '../../src/routes/orchestrate.ts'), 'utf8');
    assert.ok(orchSrc.includes('...(slot.orchestration ? { orchestration: slot.orchestration } : {})'),
        'pollers must receive the verdict the old blocking response carried (review #1)');
    const setIdx = orchSrc.indexOf('setWorkerOrchestration(slot.agentId, orchestration)');
    const finishIdx = orchSrc.indexOf('finishWorker(slot.agentId,');
    assert.ok(setIdx >= 0 && finishIdx >= 0 && setIdx < finishIdx,
        'the verdict must land on the slot BEFORE state flips to done — no verdict-less poll window');
});
