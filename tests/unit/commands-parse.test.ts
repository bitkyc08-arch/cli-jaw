import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    parseCommand,
    executeCommand,
    getCompletions,
    getCompletionItems,
    getArgumentCompletionItems,
    COMMANDS,
} from '../../src/cli/commands.ts';
import { CODEX_MODEL_CHOICES } from '../../src/cli/registry.ts';
import { resetOpenCodexModelCacheForTest } from '../../src/cli/opencodex-models.ts';

// Codex completions prefer a LIVE opencodex catalog and only fall back to the
// static registry when no runtime answers. On a developer machine running
// opencodex these tests were therefore asserting the contents of whatever that
// daemon happened to serve, and failed for a reason that had nothing to do with
// the code under test (#447). Pointing the lookup at an empty directory removes
// the runtime from the equation so the static path is the one being tested.
process.env['CLI_JAW_OPENCODEX_DIR'] = join(tmpdir(), 'cli-jaw-test-no-opencodex');
resetOpenCodexModelCacheForTest();

// ─── parseCommand ────────────────────────────────────

test('parseCommand: non-slash input returns null', () => {
    assert.equal(parseCommand('hello'), null);
    assert.equal(parseCommand(''), null);
    assert.equal(parseCommand(123), null);
});

test('parseCommand: bare "/" returns help command', () => {
    const r = parseCommand('/');
    assert.equal(r.type, 'known');
    assert.equal(r.name, 'help');
    assert.deepEqual(r.args, []);
});

test('parseCommand: known command is parsed correctly', () => {
    const r = parseCommand('/model gpt-5.3-codex-spark');
    assert.equal(r.type, 'known');
    assert.equal(r.cmd.name, 'model');
    assert.deepEqual(r.args, ['gpt-5.3-codex-spark']);
});

test('parseCommand: compact command is parsed correctly', () => {
    const r = parseCommand('/compact keep only deployment status');
    assert.equal(r.type, 'known');
    assert.equal(r.cmd.name, 'compact');
    assert.deepEqual(r.args, ['keep', 'only', 'deployment', 'status']);
});

test('parseCommand: workflow commands use remote-safe names', () => {
    for (const name of ['plan', 'interview', 'deliberate', 'planaudit', 'goal']) {
        const r = parseCommand(`/${name} draft feature`);
        assert.equal(r.type, 'known');
        assert.equal(r.cmd.name, name);
        assert.deepEqual(r.args, ['draft', 'feature']);
        assert.equal(r.rawText, `/${name} draft feature`);
    }
});

test('parseCommand: goalplan and orchestrate state commands keep text arguments', () => {
    const goalplan = parseCommand('/goalplan ddd text');
    assert.equal(goalplan.type, 'known');
    assert.equal(goalplan.name, 'goalplan');
    assert.deepEqual(goalplan.args, ['ddd', 'text']);

    const goalPlanAlias = parseCommand('/goal plan ddd text');
    assert.equal(goalPlanAlias.type, 'known');
    assert.equal(goalPlanAlias.name, 'goal');
    assert.deepEqual(goalPlanAlias.args, ['plan', 'ddd', 'text']);

    const orchestrate = parseCommand('/orchestrate P');
    assert.equal(orchestrate.type, 'known');
    assert.equal(orchestrate.name, 'orchestrate');
    assert.deepEqual(orchestrate.args, ['P']);
});

test('parseCommand: plan-audit is not registered in Phase 1', () => {
    const r = parseCommand('/plan-audit draft feature');
    assert.equal(r.type, 'unknown');
    assert.equal(r.name, 'plan-audit');
});

test('parseCommand: autopilot is not a top-level workflow command', () => {
    const r = parseCommand('/autopilot run checks');
    assert.equal(r.type, 'unknown');
    assert.equal(r.name, 'autopilot');
});

test('parseCommand: command aliases work', () => {
    const r = parseCommand('/h');
    assert.equal(r.type, 'known');
    assert.equal(r.cmd.name, 'help');
});

test('parseCommand: unknown command returns type unknown', () => {
    const r = parseCommand('/nonexistent');
    assert.equal(r.type, 'unknown');
    assert.equal(r.name, 'nonexistent');
});

test('parseCommand: multi-word args are split', () => {
    const r = parseCommand('/fallback claude codex gemini');
    assert.equal(r.type, 'known');
    assert.deepEqual(r.args, ['claude', 'codex', 'gemini']);
});

// ─── executeCommand ──────────────────────────────────

test('executeCommand: null parsed returns null', async () => {
    const r = await executeCommand(null, {});
    assert.equal(r, null);
});

test('executeCommand: unknown command returns error result', async () => {
    const r = await executeCommand({ type: 'unknown', name: 'foo', args: ['bar'], rawText: '/foo bar' }, {});
    assert.equal(r.ok, false);
    assert.equal(r.code, 'unknown_command');
    assert.equal(r.originalText, '/foo bar');
    assert.equal(r.recovery?.originalText, '/foo bar');
    assert.equal(r.artifact?.kind, 'unknownCommandRecovery');
});

test('executeCommand: /quit returns exit code', async () => {
    const parsed = parseCommand('/quit');
    const r = await executeCommand(parsed, { interface: 'cli' });
    assert.equal(r.ok, true);
    assert.equal(r.code, 'exit');
});

test('executeCommand: /settings returns fullscreen settings transition code for cli', async () => {
    const parsed = parseCommand('/settings');
    assert.equal(parsed.type, 'known');
    assert.equal(parsed.cmd.name, 'settings');
    const r = await executeCommand(parsed, { interface: 'cli' });
    assert.equal(r.ok, true);
    assert.equal(r.code, 'open_settings');
});

test('executeCommand: /clear returns clear_screen for cli', async () => {
    const parsed = parseCommand('/clear');
    const r = await executeCommand(parsed, { interface: 'cli' });
    assert.equal(r.ok, true);
    assert.equal(r.code, 'clear_screen');
});

test('executeCommand: /clear actually clears session on telegram', async () => {
    const parsed = parseCommand('/clear');
    let cleared = false;
    const r = await executeCommand(parsed, {
        interface: 'telegram',
        clearSession: async () => { cleared = true; },
    });
    assert.equal(r.ok, true);
    assert.equal(cleared, true, 'clearSession should be invoked');
    assert.ok(r.text, 'should return a confirmation text');
});

test('executeCommand: unsupported interface returns error', async () => {
    // /quit is cli-only
    const parsed = parseCommand('/quit');
    const r = await executeCommand(parsed, { interface: 'web' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'unsupported_interface');
});

test('executeCommand: /goal with unknown subcommand shows usage', async () => {
    const parsed = parseCommand('/goal ship phase 1');
    const r = await executeCommand(parsed, { interface: 'web', locale: 'en' });
    assert.ok(r.text, 'must return text response');
});

test('executeCommand: /goal run returns preflight result', async () => {
    const parsed = parseCommand('/goal run checks');
    const r = await executeCommand(parsed, { interface: 'web', locale: 'en' });
    assert.ok(r.text, 'must return text response');
});

test('executeCommand: /plan explains PABCD P without entering another mode', async () => {
    const parsed = parseCommand('/plan build artifact cache');
    const r = await executeCommand(parsed, { interface: 'web', locale: 'en' });
    assert.equal(r.ok, true);
    assert.equal(r.artifact?.kind, 'planCompat');
    assert.equal(r.artifact?.sourcePrompt, '/plan build artifact cache');
    assert.equal(r.artifact?.authoritative, false);
    assert.match(r.text, /PABCD P/);
    assert.doesNotMatch(r.text, /entered plan mode/i);
});

test('executeCommand: handler error is caught gracefully', async () => {
    const parsed = parseCommand('/status');
    // status handler calls ctx.getSettings etc — passing empty ctx will throw
    const r = await executeCommand(parsed, {});
    assert.equal(r.ok, true); // still succeeds because safeCall handles nulls
});

// ─── getCompletions / getCompletionItems ─────────────

test('getCompletions: empty partial returns all cli commands', () => {
    const list = getCompletions('', 'cli');
    assert.ok(list.length > 0);
    assert.ok(list.every(c => c.startsWith('/')));
    assert.ok(list.includes('/help'));
    assert.ok(list.includes('/status'));
});

test('getCompletions: partial filters results', () => {
    const list = getCompletions('/mod', 'cli');
    assert.ok(list.includes('/model'));
    assert.ok(!list.includes('/help'));
});

test('getCompletions: settings appears in cli completions', () => {
    const list = getCompletions('/set', 'cli');
    assert.ok(list.includes('/settings'));
});

test('executeCommand: /context remains a backed command', async () => {
    const parsed = parseCommand('/context');
    assert.equal(parsed.type, 'known');
    assert.equal(parsed.cmd.name, 'context');
    const r = await executeCommand(parsed, { interface: 'cli', apiUrl: 'http://127.0.0.1:1' });
    assert.ok(r.text);
});

test('getCompletions: compact appears in session command list', () => {
    const list = getCompletions('/com', 'cli');
    assert.ok(list.includes('/compact'));
});

test('getCompletionItems returns structured objects', () => {
    const items = getCompletionItems('/ver', 'cli');
    assert.ok(items.length >= 1);
    const ver = items.find(i => i.name === 'version');
    assert.ok(ver);
    assert.equal(ver.kind, 'command');
    assert.ok(ver.insertText.startsWith('/version'));
});

test('getCompletionItems includes workflow metadata', () => {
    const items = getCompletionItems('/inter', 'web');
    const interview = items.find(i => i.name === 'interview');
    assert.ok(interview);
    assert.equal(interview.workflow?.kind, 'workflow');
    assert.equal(interview.workflow?.phase, 'requirements');
});

test('getCompletions: telegram interface excludes cli-only commands', () => {
    const list = getCompletions('', 'telegram');
    // /quit is cli-only
    assert.ok(!list.includes('/quit'));
    // /help is available everywhere
    assert.ok(list.includes('/help'));
});

// ─── getArgumentCompletionItems ──────────────────────

test('getArgumentCompletionItems: cli command returns cli choices', async () => {
    const items = await getArgumentCompletionItems('cli', '', 'cli', [], {});
    assert.ok(items.length > 0);
    assert.ok(items.every(i => i.kind === 'argument'));
});

test('getArgumentCompletionItems: model labels use concrete provider instead of ai-e wrapper', async () => {
    const items = await getArgumentCompletionItems('model', 'gpt-5.4', 'cli', [], {});
    const item = items.find(i => i.name === 'gpt-5.4');
    assert.ok(item);
    assert.notEqual(item.desc, 'ai-e');
});

// Assert on the registry rather than a hardcoded id: the point is that the static
// catalog reaches completions, not that any particular model is in it forever.
const staticCodexModel = CODEX_MODEL_CHOICES.find(m => m.includes('spark')) ?? CODEX_MODEL_CHOICES[0]!;

test('getArgumentCompletionItems: model command offers the static Codex catalog when no runtime answers', async () => {
    const items = await getArgumentCompletionItems('model', staticCodexModel, 'cli', [], {});
    assert.ok(items.some(i => i.name === staticCodexModel),
        `expected ${staticCodexModel} from CODEX_MODEL_CHOICES, got: ${items.map(i => i.name).join(', ')}`);
});

test('getArgumentCompletionItems: employee model command uses the same Codex catalog', async () => {
    const items = await getArgumentCompletionItems('employee', staticCodexModel, 'cli', ['model', 'Control'], {});
    assert.ok(items.some(i => i.name === staticCodexModel),
        `expected ${staticCodexModel}, got: ${items.map(i => i.name).join(', ')}`);
});

test('getArgumentCompletionItems: employee cli command returns cli choices', async () => {
    const items = await getArgumentCompletionItems('employee', 'cod', 'cli', ['cli'], {});
    assert.ok(items.some(i => i.name === 'codex'));
});

test('getArgumentCompletionItems: unknown command returns empty', async () => {
    const items = await getArgumentCompletionItems('nonexistent', '', 'cli');
    assert.deepEqual(items, []);
});

test('executeCommand: thought toggles showReasoning setting', async () => {
    const calls = [];
    const parsed = parseCommand('/thought on');
    const r = await executeCommand(parsed, {
        interface: 'web',
        getSettings: async () => ({ showReasoning: false }),
        updateSettings: async (patch) => {
            calls.push(patch);
            return { ok: true };
        },
    });
    assert.equal(r.ok, true);
    assert.deepEqual(calls, [{ showReasoning: true }]);
});

// ─── COMMANDS registry integrity ─────────────────────

test('COMMANDS: every command has required fields', () => {
    for (const cmd of COMMANDS) {
        assert.equal(typeof cmd.name, 'string', `command missing name`);
        assert.equal(typeof cmd.desc, 'string', `${cmd.name} missing desc`);
        assert.ok(Array.isArray(cmd.interfaces), `${cmd.name} missing interfaces`);
        assert.equal(typeof cmd.handler, 'function', `${cmd.name} missing handler`);
    }
});

test('COMMANDS: no duplicate names', () => {
    const names = COMMANDS.map(c => c.name);
    assert.equal(names.length, new Set(names).size);
});

test('executeCommand: compact returns busy error when runtime is active', async () => {
    const parsed = parseCommand('/compact');
    const r = await executeCommand(parsed, {
        interface: 'cli',
        getSettings: async () => ({ cli: 'codex', perCli: { codex: { model: 'default' } } }),
        getSession: async () => ({ active_cli: 'codex', model: 'default' }),
        getRuntime: async () => ({ activeAgent: true }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'compact_busy');
});

test('executeCommand: /employee sessions-reset clears employee resume sessions only', async () => {
    const parsed = parseCommand('/employee sessions-reset');
    let called = false;
    const r = await executeCommand(parsed, {
        interface: 'web',
        locale: 'en',
        resetEmployeeSessions: async () => {
            called = true;
            return { cleared: 2 };
        },
    });

    assert.equal(r.ok, true);
    assert.equal(called, true);
    assert.equal(r.text, 'cmd.employee.sessionsResetDone');
});
