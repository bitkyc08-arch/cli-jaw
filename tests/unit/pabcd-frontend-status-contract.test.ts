import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeStrictPropertyAccess } from './source-normalize';

const projectRoot = join(import.meta.dirname, '../..');
const stateSrc = normalizeStrictPropertyAccess(readFileSync(join(projectRoot, 'public/js/state.ts'), 'utf8'));
const wsSrc = normalizeStrictPropertyAccess(readFileSync(join(projectRoot, 'public/js/ws.ts'), 'utf8'));
const htmlSrc = readFileSync(join(projectRoot, 'public/index.html'), 'utf8');
const cssSrc = readFileSync(join(projectRoot, 'public/css/orc-state.css'), 'utf8');

test('frontend state has heartbeat runtime and PABCD task anchor fields', () => {
    assert.ok(stateSrc.includes('interface HeartbeatRuntimeState'));
    assert.ok(stateSrc.includes('heartbeatRuntime: HeartbeatRuntimeState'));
    assert.ok(stateSrc.includes('orcTaskAnchor: string'));
    assert.ok(stateSrc.includes('orcResolvedSelection'));
});

test('ws snapshot restores heartbeat and task anchor status', () => {
    assert.ok(wsSrc.includes('applyHeartbeatRuntime(snap.heartbeat'));
    assert.ok(wsSrc.includes('applyOrcContext(snap.orc.ctx'));
    assert.ok(wsSrc.includes('ctx?.taskAnchor'));
    assert.ok(wsSrc.includes('ctx?.resolvedSelection'));
});

test('ws handles heartbeat_pending without rendering a chat message', () => {
    const branchIdx = wsSrc.indexOf("msg.type === 'heartbeat_pending'");
    assert.ok(branchIdx > -1, 'heartbeat_pending branch must exist');
    const branch = wsSrc.slice(branchIdx, branchIdx + 900);
    assert.ok(branch.includes('applyHeartbeatRuntime'));
    assert.ok(!branch.includes('addSystemMsg('), 'deferred heartbeat status must not become system chat');
    assert.ok(!branch.includes('addMessage('), 'deferred heartbeat status must not become chat message');
});

test('stable DOM and CSS targets exist for PABCD anchor and heartbeat status', () => {
    assert.ok(htmlSrc.includes('id="pabcTaskAnchor"'));
    assert.ok(htmlSrc.includes('id="pabcHeartbeatStatus"'));
    assert.ok(cssSrc.includes('.pabc-anchor'));
    assert.ok(cssSrc.includes('.pabc-heartbeat-status'));
});
