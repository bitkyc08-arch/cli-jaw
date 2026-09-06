import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Config, DB, and SDK modules must see only this file's homes. Keep the Node test
// protocol identity, but inherit no provider/account environment or credentials.
const root = fs.mkdtempSync(join(tmpdir(), 'wp19-memory-policy-'));
for (const key of Object.keys(process.env)) {
    if (!['PATH', 'LANG', 'LC_ALL', 'NO_COLOR', 'NODE_TEST_CONTEXT'].includes(key)) delete process.env[key];
}
for (const key of ['HOME', 'CLI_JAW_HOME', 'CLI_JAW_DASHBOARD_HOME', 'TMPDIR', 'CODEX_HOME',
    'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) {
    process.env[key] = join(root, key); fs.mkdirSync(process.env[key]!);
}
process.env.NODE_ENV = 'test';
process.env.CLI_JAW_SKIP_AUTOMATION_PRIME = '1';
process.env.JAW_DASHBOARD_OPEN = '0';
process.env.JAW_OPEN_BROWSER = '0';

const config = await import('../../src/core/config.ts');
const detection = test.mock.fn(() => { throw new Error('unexpected CLI detection'); });
test.mock.module('../../src/core/config.js', { namedExports: { ...config, detectCli: detection } });
const sdkLoad = test.mock.fn(async () => { throw new Error('unexpected SDK load'); });
test.mock.module('../../src/agent/runtime/claude-sdk-loader.js', { namedExports: { loadClaudeSdk: sdkLoad } });
const sdk = await import('../../src/agent/runtime/claude-sdk-session.ts');
const sdkFactory = test.mock.fn(async () => { throw new Error('unexpected SDK session factory'); });
test.mock.module('../../src/agent/runtime/claude-sdk-session.js', {
    namedExports: { ...sdk, createClaudeSdkSession: sdkFactory },
});
// Do not mock this edge: the actual controller invokes the actual spawn preflight.
const { spawnAgent, activeProcesses, activeMainProcesses, hasActiveAgent } = await import('../../src/agent/spawn.ts');
const { setSpawnRef, triggerMemoryFlush, triggerMemoryFlushForCurrentSession,
    resetFlushCountersForTest, getFlushStatus } = await import('../../src/agent/memory-flush-controller.ts');
const { isNativeWorkerImplemented } = await import('../../src/agent/runtime/selection.ts');
const { hasClaudeRuns } = await import('../../src/agent/runtime/claude-run-controls.ts');
const { db } = await import('../../src/core/db.ts');
const { setActiveChatSession } = await import('../../src/core/chat-sessions.ts');
const { getMemoryFlushFilePath } = await import('../../src/memory/runtime.ts');
const { buildArgs } = await import('../../src/agent/args.ts');

type FlushSpawn = Parameters<typeof setSpawnRef>[0];
type CallerOptions = Parameters<FlushSpawn>[1];
type Attempt = { prompt: string; options: CallerOptions; run: ReturnType<typeof spawnAgent> };
const workingDir = join(root, 'project');
fs.mkdirSync(workingDir);
const sysPrompt = 'OUTPUT_ONLY_SYSTEM_FIXTURE';
const contents = ['Remember the fixture choice.', 'The fixture choice is blue.',
    'Keep the fixture output brief.', 'The fixture output stays prose.'];
const memoryFile = () => getMemoryFlushFilePath(new Date().toISOString().slice(0, 10));

function expectedOptions(): CallerOptions {
    return { agentId: 'memory-flush', internal: true, forceNew: true,
        _skipInsert: true, _skipHistory: true, cli: 'claude', model: 'flush-only-model',
        sysPrompt, permissions: 'deny' };
}

beforeEach(t => {
    assert.equal(getFlushStatus().locked, false);
    resetFlushCountersForTest();
    detection.mock.resetCalls(); sdkFactory.mock.resetCalls(); sdkLoad.mock.resetCalls();
    config.settings.cli = 'codex'; // Distinct default proves the flush-specific CLI wins.
    config.settings.permissions = 'auto';
    config.settings.workingDir = workingDir; config.settings.projectDirs = [workingDir];
    config.settings.activeOverrides = {}; config.settings.fallbackOrder = [];
    config.settings.multiSession.enabled = true;
    config.settings.perCli.claude = { model: 'parent-model', effort: 'medium', transport: 'native' };
    config.settings.memory = { ...config.settings.memory, enabled: true, flushEvery: 10,
        cli: 'claude', model: 'flush-only-model' };
    fs.mkdirSync(join(config.JAW_HOME, 'prompts'), { recursive: true });
    fs.writeFileSync(join(config.JAW_HOME, 'prompts', 'flush-system.md'), sysPrompt);
    db.prepare('DELETE FROM messages').run(); // Only this test file's isolated DB.
    setActiveChatSession('default');
    const insert = db.prepare('INSERT INTO messages (role,content,cli,model,session_id,working_dir) VALUES (?,?,?,?,?,?)');
    contents.forEach((content, i) => insert.run(i % 2 ? 'assistant' : 'user', content,
        'fixture', 'fixture', 'default', workingDir));
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'error', () => {});
    const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network'); });
    t.after(() => {
        setSpawnRef(spawnAgent, activeProcesses);
        assert.equal(network.mock.callCount(), 0);
        assert.equal(getFlushStatus().locked, false);
        assert.equal(activeProcesses.size, 0); assert.equal(activeMainProcesses.size, 0);
        assert.equal(hasClaudeRuns(), false);
    });
});
after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

for (const [mode, globalPolicy] of [['merged', 'auto'], ['manual', 'safe']] as const) {
    test(`${mode} actual flush caller keeps deny through native spawn admission with ${globalPolicy} global policy`,
        { timeout: 6000, concurrency: false }, async t => {
            config.settings.permissions = globalPolicy;
            assert.equal(config.settings.memory.enabled, true);
            assert.equal(isNativeWorkerImplemented('claude'), true,
                'must exercise deny-policy admission, not an unavailable-worker shortcut');
            const attempts: Attempt[] = [];
            setSpawnRef((prompt, options) => {
                const captured = { ...options };
                const run = spawnAgent(prompt, options); // Forward the actual envelope unchanged.
                attempts.push({ prompt, options: captured, run });
                return run;
            }, activeProcesses);
            const mkdir = t.mock.method(fs, 'mkdirSync', () => { throw new Error('unexpected directory preparation'); });
            const mkdtemp = t.mock.method(fs, 'mkdtempSync', () => { throw new Error('unexpected employee cwd'); });
            const trigger = mode === 'merged' ? triggerMemoryFlush : triggerMemoryFlushForCurrentSession;
            // Two explicit attempts prove the failure releases the lock but consumes no rows.
            for (let i = 0; i < 2; i++) {
                assert.equal(await trigger(), 'started');
                assert.equal(attempts.length, i + 1, 'flush must actually reach spawn');
                const attempt = attempts[i]!;
                assert.deepEqual(attempt.options, expectedOptions());
                for (const content of contents) assert.ok(attempt.prompt.includes(content));
                assert.equal(attempt.run.child, null);
                assert.deepEqual(await attempt.run.promise, { code: 78,
                    text: 'Claude native supports auto or safe permissions. Select print to retain this permission profile.' });
                assert.equal(getFlushStatus().locked, false);
                assert.deepEqual(getFlushStatus().lastFlushedMessageIdBySession, {});
                assert.equal(getFlushStatus().lastFlushedMessageId, null);
            }
            assert.equal(detection.mock.callCount(), 0);
            assert.equal(sdkFactory.mock.callCount(), 0); assert.equal(sdkLoad.mock.callCount(), 0);
            assert.equal(mkdir.mock.callCount(), 0); assert.equal(mkdtemp.mock.callCount(), 0);
            assert.equal(fs.existsSync(memoryFile()), false);
            assert.equal(hasActiveAgent('memory-flush'), false);
            assert.equal(config.settings.permissions, globalPolicy);
            assert.equal(config.settings.perCli.claude.transport, 'native', 'no automatic print fallback');
        });
}

test('print controller options preserve deny and fresh/no-history semantics with the real argument builder (controlled spawn)',
    { timeout: 6000, concurrency: false }, async () => {
        config.settings.perCli.claude.transport = 'print';
        const completed = Promise.withResolvers<{ text: string; code: number }>();
        const calls: Array<{ prompt: string; options: CallerOptions; args: string[] }> = [];
        setSpawnRef((prompt, options) => {
            calls.push({ prompt, options: { ...options }, args: buildArgs(options.cli, options.model,
                'medium', prompt, options.sysPrompt, options.permissions) });
            return { child: null, promise: completed.promise };
        }, activeProcesses);
        try {
            assert.equal(await triggerMemoryFlushForCurrentSession(), 'started');
            assert.equal(calls.length, 1);
            assert.equal(getFlushStatus().locked, true, 'valid rows reached the controlled extractor');
            assert.equal(config.settings.memory.enabled, true);
            const call = calls[0]!;
            assert.deepEqual(call.options, expectedOptions());
            for (const content of contents) assert.ok(call.prompt.includes(content));
            assert.deepEqual(call.args, ['--print', '--verbose', '--output-format', 'stream-json',
                '--include-partial-messages', '--max-turns', '500', '--model', 'flush-only-model',
                '--append-system-prompt', sysPrompt]);
            assert.equal(call.args.includes('--dangerously-skip-permissions'), false);
            assert.equal(call.args.includes('--resume'), false);
            assert.equal(config.settings.permissions, 'auto', 'extractor must not inherit the global bypass');
        } finally {
            completed.resolve({ text: 'SKIP', code: 0 });
            await completed.promise; // Controller registered completion before this await.
        }
        assert.equal(getFlushStatus().locked, false);
        const max = db.prepare('SELECT MAX(id) AS id FROM messages').get() as { id: number };
        assert.deepEqual(getFlushStatus().lastFlushedMessageIdBySession, { default: max.id });
        assert.equal(fs.existsSync(memoryFile()), false, 'SKIP consumes rows without file/index/provider work');
        assert.equal(detection.mock.callCount(), 0);
        assert.equal(sdkFactory.mock.callCount(), 0); assert.equal(sdkLoad.mock.callCount(), 0);
    });
