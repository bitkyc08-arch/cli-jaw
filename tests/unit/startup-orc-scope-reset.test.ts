// #458: this file writes the shared `orc_state` 'default' row. tests/run.mts forks
// per file but every child inherits ONE CLI_JAW_HOME, so without an isolated home a
// concurrent file's resetState() clobbers this file's setState() mid-assertion.
// Must be the FIRST import: config.ts binds DB_PATH at module evaluation.
import '../setup/isolated-home.ts';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getState, setState, resetState, resetAllStaleStates } from '../../src/orchestrator/state-machine.ts';
import { setOrcState } from '../../src/core/db.ts';

const serverSrc = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');

afterEach(() => { resetState('default'); resetState('legacy:scope'); });

test('SOS-001: startup calls resetAllStaleStates (single-scope)', () => {
    assert.ok(serverSrc.includes('resetAllStaleStates()'),
        'server must call resetAllStaleStates on startup');
    assert.ok(serverSrc.includes("import { resetAllStaleStates }"),
        'server must import resetAllStaleStates');
});

test('SOS-002: snapshot endpoint includes scope', () => {
    const orchestrateSrc = readFileSync(new URL('../../src/routes/orchestrate.ts', import.meta.url), 'utf8');
    const snapStart = orchestrateSrc.indexOf("app.get('/api/orchestrate/snapshot'");
    assert.ok(snapStart >= 0, 'snapshot route should exist');
    const snapBlock = orchestrateSrc.slice(snapStart, snapStart + 3000);
    assert.ok(/orc:\s*\{[\s\S]*?\bscope\b/.test(snapBlock), 'snapshot orc object should include scope field');
    assert.ok(snapBlock.includes('state: getState(scope)'), 'snapshot should include state from getState(scope)');
});

test('SOS-003: channel-up hydration pulls scope state from the snapshot (X-01)', () => {
    // the WS connect-time orc_state push was removed —
    // reload recovery now flows through /api/orchestrate/snapshot (SOS-002)
    // fetched by handleChannelUp on every (re)connect, for SSE and WS alike.
    const wsSrc = readFileSync(new URL('../../public/js/ws.ts', import.meta.url), 'utf8');
    const upIdx = wsSrc.indexOf('function handleChannelUp');
    assert.ok(upIdx >= 0, 'handleChannelUp should exist');
    const block = wsSrc.slice(upIdx, upIdx + 1500);
    assert.ok(block.includes("syncOrchestrateSnapshot('reconnect'"),
        'channel-up must sync the orchestrate snapshot (orc scope/state source)');
    assert.ok(block.includes('refreshMemorySidebar'),
        'channel-up must hydrate the memory badge (was a WS connect push)');
    assert.ok(wsSrc.includes("onChannelOpen(() => handleChannelUp('sse'))"),
        'handleChannelUp must be wired to the SSE channel-open callback');
});

test('SOS-004: resetAllStaleStates preserves recent states and resets stale ones', () => {
    setState('P', {
        originalPrompt: 'fresh task', workingDir: null, scopeId: 'default',
        plan: null, workerResults: [], origin: 'web',
    }, 'default');
    assert.equal(getState('default'), 'P');

    resetAllStaleStates();
    assert.equal(getState('default'), 'P', 'fresh state (<24h) must be preserved');

    // Backdate the row to simulate a stale session (>24h old)
    const db = (setOrcState as unknown as { database: import('better-sqlite3').Database }).database;
    db.prepare("UPDATE orc_state SET updated_at = datetime('now', '-25 hours') WHERE id = 'default'").run();

    resetAllStaleStates();
    assert.equal(getState('default'), 'IDLE', 'stale state (>24h) must be reset');
});

test('SOS-005: resetAllStaleStates preserves fresh non-default rows', () => {
    setState('A', {
        originalPrompt: 'legacy', workingDir: '/tmp', scopeId: 'legacy:scope',
        plan: null, workerResults: [], origin: 'web',
    }, 'legacy:scope');
    assert.equal(getState('legacy:scope'), 'A');

    resetAllStaleStates();
    assert.equal(getState('legacy:scope'), 'A');
});
