// A scoped Codex App row is the resume authority once multiplex owns a run, so
// anything that tells the user their session was reset has to drop those rows
// too. Leaving one behind means the next multiplex run silently resumes the
// thread the user just discarded.
import test from 'node:test';
import assert from 'node:assert/strict';

type ClearCall = { bucket: string; pattern: string };
const prefixClears: ClearCall[] = [];
const singleClears: string[] = [];
const scopeBumps: string[] = [];
let globalBumps = 0;

test.mock.module('../../src/core/db.ts', {
    namedExports: {
        db: { transaction: (fn: () => void) => () => { fn(); } },
        insertMessageWithTrace: { run: () => {} },
        clearSessionBucket: { run: (bucket: string) => { singleClears.push(bucket); } },
        clearSessionBucketsByPrefix: {
            run: (bucket: string, pattern: string) => { prefixClears.push({ bucket, pattern }); },
        },
        getMemory: { all: () => [] },
        upsertMemory: { run: () => {} },
        deleteMemory: { run: () => {} },
        getRecentMessages: {
            all: () => [
                { role: 'user', content: 'hello there', cli: 'codex-app', model: 'gpt-5.5' },
                { role: 'assistant', content: 'general kenobi', cli: 'codex-app', model: 'gpt-5.5' },
            ],
        },
        getRecentMessagesLite: {
            all: () => [
                { role: 'user', content: 'hello there', cli: 'codex-app', model: 'gpt-5.5' },
                { role: 'assistant', content: 'general kenobi', cli: 'codex-app', model: 'gpt-5.5' },
            ],
        },
        getRecentToolLogs: { all: () => [] },
        searchMessages: { all: () => [] },
        clearMessages: { run: () => {} },
        clearMessagesScoped: { run: () => {} },
        getSession: { get: () => ({}) },
        updateSession: { run: () => {} },
    },
});
test.mock.module('../../src/core/main-session.ts', {
    namedExports: {
        clearBossSessionOnly: () => {},
        setPendingBootstrapPrompt: () => {},
        setPendingBootstrapPromptStrict: () => {},
        writeMainSessionRow: () => {},
        buildClearedSessionRow: () => ({}),
    },
});
test.mock.module('../../src/agent/session-persistence.ts', {
    namedExports: {
        bumpSessionOwnershipGeneration: () => { globalBumps += 1; },
        bumpScopeSessionGeneration: (scopeKey: string) => { scopeBumps.push(scopeKey); },
    },
});
test.mock.module('../../src/core/chat-sessions.ts', {
    namedExports: { getActiveChatSession: () => 'chat-1' },
});

const coreCompact = await import('../../src/core/compact.js');
const cliCompact = await import('../../src/cli/compact.js');

function reset(): void {
    prefixClears.length = 0;
    singleClears.length = 0;
    scopeBumps.length = 0;
    globalBumps = 0;
}

test('switching into Codex App drops the scoped rows along with the legacy one', async () => {
    reset();
    await coreCompact.cliSwitchRefresh({
        sourceWorkDir: '/tmp/from', targetWorkDir: '/tmp/to',
        fromCli: 'claude', toCli: 'codex-app', toModel: 'gpt-5.5',
    });
    assert.deepEqual(prefixClears, [{ bucket: 'codex-app', pattern: 'codex-app:%' }]);
    assert.deepEqual(singleClears, [], 'the codex-app branch owns the whole clear');
});

test('switching into another CLI leaves the Codex App rows untouched', async () => {
    reset();
    await coreCompact.cliSwitchRefresh({
        sourceWorkDir: '/tmp/from', targetWorkDir: '/tmp/to',
        fromCli: 'codex-app', toCli: 'claude', toModel: 'sonnet',
    });
    assert.deepEqual(prefixClears, [], 'a non-codex switch must not touch scoped rows');
    assert.deepEqual(singleClears, ['claude']);
});

test('a run-owned auto compact invalidates only its own scope', async () => {
    reset();
    await coreCompact.autoCompactRefresh({
        workDir: '/tmp', instructions: '', cli: 'codex-app', model: 'gpt-5.5',
        scopeKey: 'slack:C123', sessionBucket: 'codex-app:slack:C123:gpt-5.5:high',
    });
    assert.deepEqual(scopeBumps, ['slack:C123']);
    assert.equal(globalBumps, 0, 'one scope compacting must not reject other scopes');
    assert.deepEqual(singleClears, ['codex-app:slack:C123:gpt-5.5:high']);
});

test('an auto compact without a scope keeps the old global invalidation', async () => {
    reset();
    await coreCompact.autoCompactRefresh({ workDir: '/tmp', instructions: '', cli: 'claude', model: 'sonnet' });
    assert.deepEqual(scopeBumps, []);
    assert.equal(globalBumps, 1);
});

test('an explicit compact drops the scoped rows too', async () => {
    reset();
    const result = await cliCompact.compactHandler([], {
        getSettings: () => ({ cli: 'codex-app', workingDir: '/tmp', perCli: {} }),
        getSession: () => ({}),
        getRuntime: () => ({ activeAgent: false }),
    } as never);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(prefixClears, [{ bucket: 'codex-app', pattern: 'codex-app:%' }],
        'a compact that leaves scoped rows lets the discarded thread come back');
    assert.deepEqual(singleClears, []);
});
