// ── Goal continuation boundary + external live-render contracts ──

// Bug 2: goal continuations spawn with _skipInsert, so no user row lands
// between work-phases. After an SSE reconnect the client's
// latestAgentDivForActiveRun() heuristic ("last .msg-agent with no following
// user message") re-attached the new run's tool steps onto the PREVIOUS
// assistant bubble. Fix: insert a durable 'goal_continuation' user boundary
// row (+ broadcast) before each continuation spawn.
// Bug 1: externally-injected user messages (manager relay, preview relay)
// arrived as source 'web' and were dropped by the web UI's new_message
// source allowlist. Fix: external:true marker end-to-end.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '../..');
const lifecycleSrc = readFileSync(join(root, 'src/agent/lifecycle-handler.ts'), 'utf8');
const spawnSrc = readFileSync(join(root, 'src/agent/spawn.ts'), 'utf8');
const gatewaySrc = readFileSync(join(root, 'src/orchestrator/gateway.ts'), 'utf8');
const commandSrc = readFileSync(join(root, 'src/routes/command.ts'), 'utf8');
const managerSrc = readFileSync(join(root, 'src/manager/server.ts'), 'utf8');
const wsSrc = readFileSync(join(root, 'public/js/ws.ts'), 'utf8');
const chatSrc = readFileSync(join(root, 'public/js/features/chat.ts'), 'utf8');
const chatMessagesSrc = readFileSync(join(root, 'public/js/features/chat-messages.ts'), 'utf8');

// ─── Bug 2: goal continuation boundary rows ───

test('GCB-001: boundary helper inserts a durable user row and broadcasts new_message', () => {
    const idx = lifecycleSrc.indexOf('function insertGoalContinuationBoundary(');
    assert.ok(idx > 0, 'insertGoalContinuationBoundary must exist');
    const block = lifecycleSrc.slice(idx, lifecycleSrc.indexOf('\n}', idx));
    assert.ok(block.includes("insertMessage.run('user'"), 'boundary must persist a user row');
    assert.ok(block.includes("'goal_continuation'"), 'boundary row must carry the goal_continuation cli marker');
    assert.ok(block.includes("broadcast('new_message'"), 'boundary must broadcast new_message for live render');
    assert.ok(block.includes("source: 'goal'"), 'boundary broadcast must use goal source so the web UI renders it');
});

test('GCB-002: every goal continuation/resume spawn is preceded by a boundary insert', () => {
    // manual kick + auto-continuation + scheduled wakeup resume
    const calls = lifecycleSrc.match(/insertGoalContinuationBoundary\(/g) || [];
    assert.ok(calls.length >= 4, `expected >=4 references (1 def + 3 call sites), found ${calls.length}`);
    const kickIdx = lifecycleSrc.indexOf('kicking manual goal continuation');
    const kickBlock = lifecycleSrc.slice(kickIdx, kickIdx + 800);
    assert.ok(kickBlock.includes('insertGoalContinuationBoundary('), 'manual kick must insert boundary before spawn');
    const wakeIdx = lifecycleSrc.indexOf('firing delayed resume');
    const wakeBlock = lifecycleSrc.slice(wakeIdx, wakeIdx + 500);
    assert.ok(wakeBlock.includes('insertGoalContinuationBoundary('), 'wakeup resume must insert boundary before spawn');
});

test('GCB-003: history block skips goal_continuation marker rows', () => {
    const idx = spawnSrc.indexOf('function buildHistoryBlock(');
    const block = spawnSrc.slice(idx, idx + 2000);
    assert.ok(block.includes("row.cli === 'goal_continuation'"), 'buildHistoryBlock must skip goal_continuation rows');
});

test('GCB-004: boundary rows render as slim markers but keep .msg-user boundary semantics', () => {
    assert.ok(chatMessagesSrc.includes("cli === 'goal_continuation'"), 'addMessage must detect boundary rows');
    assert.ok(chatMessagesSrc.includes('msg-goal-boundary'), 'addMessage must add the modifier class');
    // The class list must still contain msg-user (boundary signal for hasFollowingUserMessage).
    assert.ok(chatMessagesSrc.includes('msg msg-${role}${isGoalBoundary'), 'msg-user base class must be preserved');
    const cssSrc = readFileSync(join(root, 'public/css/chat.css'), 'utf8');
    assert.ok(cssSrc.includes('.msg-goal-boundary'), 'boundary style must exist');
});

// ─── Bug 1: external live-render path ───

test('EXT-001: /api/message accepts external:true and forwards it to submitMessage', () => {
    assert.ok(commandSrc.includes('req.body?.external === true'), 'route must validate external strictly');
    const metaIdx = commandSrc.indexOf('const submitMeta');
    const metaBlock = commandSrc.slice(metaIdx, metaIdx + 400);
    assert.ok(metaBlock.includes('external'), 'submitMeta must carry external');
});

test('EXT-002: gateway new_message broadcasts include the external marker', () => {
    const sites = gatewaySrc.match(/broadcast\('new_message'/g) || [];
    assert.ok(sites.length >= 3, 'gateway should have >=3 new_message broadcasts');
    const tagged = gatewaySrc.match(/broadcast\('new_message', stripUndefined\(\{[^}]*external: meta\.external/g) || [];
    assert.equal(tagged.length, sites.length, 'every gateway new_message must carry external when set');
});

test('EXT-003: manager relays declare external:true', () => {
    // One relay now also forwards a session id, so match the marker rather than the
    // whole literal — the point of the test is that neither relay drops external:true.
    const relays = managerSrc.match(/JSON\.stringify\([^)]*external: true[^)]*\)/g) || [];
    assert.ok(relays.length >= 2, `both manager relay POSTs must send external:true, found ${relays.length}`);
});

test('EXT-004: web UI renders external/cli/goal new_message live', () => {
    const nmIdx = wsSrc.indexOf("msg.type === 'new_message'");
    const nmCond = wsSrc.slice(nmIdx, wsSrc.indexOf('{', nmIdx));
    assert.ok(nmCond.includes('msg.external === true'), 'external marker must pass the live filter');
    assert.ok(nmCond.includes("msg.source === 'cli'"), 'cli-origin messages must pass the live filter');
    assert.ok(nmCond.includes("msg.source === 'goal'"), 'goal boundary rows must pass the live filter');
});

test('EXT-005: preview relay sends skip the local addMessage (SSE owns the bubble)', () => {
    assert.ok(chatSrc.includes('viaRelay'), 'relay result must be marked');
    const relayIdx = chatSrc.indexOf('result.viaRelay');
    assert.ok(relayIdx > 0, 'send path must branch on viaRelay');
    const relayBlock = chatSrc.slice(relayIdx, relayIdx + 500);
    assert.ok(!relayBlock.slice(0, 300).includes("addMessage('user'"), 'viaRelay branch must not locally addMessage');
});
