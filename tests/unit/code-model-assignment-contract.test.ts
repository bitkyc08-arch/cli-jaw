import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    buildJwcModelRole,
    clearJwcModelAssignment,
    isJwcModelAssignmentRole,
    normalizeJwcThinkingLevel,
    readJwcModelAssignments,
    resolveJwcModelAssignments,
    writeJwcModelAssignment,
} from '../../src/code-mode/model-options.ts';
import { normalizeStrictPropertyAccess } from './source-normalize.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..');

function read(path: string): string {
    return normalizeStrictPropertyAccess(readFileSync(join(root, path), 'utf8'));
}

function roleById(assignments: Awaited<ReturnType<typeof readJwcModelAssignments>>, role: string) {
    const assignment = assignments.find(entry => entry.role === role);
    assert.ok(assignment, `missing assignment role ${role}`);
    return assignment;
}

test('JWC model assignment helper writes default to modelRoles.default', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'cli-jaw-jwc-assignment-'));
    try {
        await writeJwcModelAssignment('default', 'openai-codex/gpt-5.4:high', agentDir);
        const assignments = await readJwcModelAssignments(agentDir);
        const defaultRole = roleById(assignments, 'default');

        assert.equal(defaultRole.settingsPath, 'modelRoles');
        assert.equal(defaultRole.modelId, 'openai-codex/gpt-5.4:high');
        assert.equal(defaultRole.provider, 'openai-codex');
        assert.equal(defaultRole.model, 'gpt-5.4');
        assert.equal(defaultRole.thinkingLevel, 'high');
        assert.match(await readFile(join(agentDir, 'config.yml'), 'utf8'), /modelRoles:\n\s+default: openai-codex\/gpt-5\.4:high/);
    } finally {
        await rm(agentDir, { recursive: true, force: true });
    }
});

test('JWC model assignment helper writes subagent roles to task.agentModelOverrides', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'cli-jaw-jwc-assignment-'));
    try {
        await writeJwcModelAssignment('executor_ext', 'fireworks/accounts/fireworks/models/deepseek-v3', agentDir);
        await writeJwcModelAssignment('executor', 'anthropic/claude-haiku-4-5', agentDir);
        await writeJwcModelAssignment('architect', 'openai-codex/gpt-5.4:high', agentDir);
        const assignments = await readJwcModelAssignments(agentDir);

        assert.equal(roleById(assignments, 'executor_ext').modelId, 'fireworks/accounts/fireworks/models/deepseek-v3');
        assert.equal(roleById(assignments, 'executor_ext').model, 'accounts/fireworks/models/deepseek-v3');
        assert.equal(roleById(assignments, 'executor').modelId, 'anthropic/claude-haiku-4-5');
        assert.equal(roleById(assignments, 'architect').thinkingLevel, 'high');

        const content = await readFile(join(agentDir, 'config.yml'), 'utf8');
        assert.match(content, /task:\n\s+agentModelOverrides:\n\s+executor_ext: fireworks\/accounts\/fireworks\/models\/deepseek-v3/);
        assert.match(content, /executor: anthropic\/claude-haiku-4-5/);
        assert.match(content, /architect: openai-codex\/gpt-5\.4:high/);
        assert.doesNotMatch(content, /task\.agentModelOverrides:/);
    } finally {
        await rm(agentDir, { recursive: true, force: true });
    }
});

test('JWC model assignment helper preserves unrelated config keys and sibling overrides', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'cli-jaw-jwc-assignment-'));
    try {
        await writeFile(join(agentDir, 'config.yml'), [
            'theme:',
            '  dark: mono',
            'modelRoles:',
            '  default: anthropic/claude-sonnet-4-6',
            'task:',
            '  agentModelOverrides:',
            '    planner: openai-codex/gpt-5.4:medium',
            'providers:',
            '  webSearch: codex',
            '',
        ].join('\n'), 'utf8');
        await writeJwcModelAssignment('critic', 'anthropic/claude-opus-4-8:xhigh', agentDir);
        await clearJwcModelAssignment('planner', agentDir);
        const content = await readFile(join(agentDir, 'config.yml'), 'utf8');

        assert.match(content, /theme:\n\s+dark: mono/);
        assert.match(content, /providers:\n\s+webSearch: codex/);
        assert.match(content, /critic: anthropic\/claude-opus-4-8:xhigh/);
        assert.doesNotMatch(content, /planner:/);
    } finally {
        await rm(agentDir, { recursive: true, force: true });
    }
});

test('JWC model assignment readback includes all supported roles and active model note', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'cli-jaw-jwc-assignment-'));
    try {
        const readback = await resolveJwcModelAssignments(agentDir);
        assert.deepEqual(readback.roles.map(entry => entry.role), [
            'default',
            'executor_ext',
            'executor',
            'architect',
            'planner',
            'critic',
        ]);
        assert.equal(readback.activeModel.scope, 'session');
        assert.match(readback.activeModel.note, /do not mutate/i);
    } finally {
        await rm(agentDir, { recursive: true, force: true });
    }
});

test('JWC model assignment role guard rejects unknown roles', () => {
    assert.equal(isJwcModelAssignmentRole('executor_ext'), true);
    assert.equal(isJwcModelAssignmentRole('executor'), true);
    assert.equal(isJwcModelAssignmentRole('smol'), false);
});

test('JWC model role builder normalizes thinking selector values', () => {
    assert.equal(normalizeJwcThinkingLevel('min'), 'minimal');
    assert.equal(normalizeJwcThinkingLevel('minimal'), 'minimal');
    assert.equal(normalizeJwcThinkingLevel('inherit'), undefined);
    assert.equal(normalizeJwcThinkingLevel(''), undefined);
    assert.equal(buildJwcModelRole('anthropic', 'claude-sonnet-4-6', 'min'), 'anthropic/claude-sonnet-4-6:minimal');
    assert.equal(buildJwcModelRole('anthropic', 'claude-sonnet-4-6', 'inherit'), 'anthropic/claude-sonnet-4-6');
    assert.equal(buildJwcModelRole('openai-codex', 'gpt-5.4', 'xhigh'), 'openai-codex/gpt-5.4:xhigh');
});

test('code model assignment route and client contracts exist without live model mutation', () => {
    const routes = read('src/routes/code.ts');
    const client = read('public/manager/src/code/code-session-client.ts');
    const modelOptions = read('src/code-mode/model-options.ts');

    assert.ok(modelOptions.includes('buildJwcModelRole'), 'helper must expose structured model-role builder');
    assert.ok(modelOptions.includes("normalized === 'min'"), 'helper must normalize display min to canonical minimal');
    assert.ok(modelOptions.includes("normalized === 'inherit'"), 'helper must map inherit to no suffix');
    assert.ok(modelOptions.includes('task.agentModelOverrides'), 'helper must encode JWC assignment settings path');
    assert.ok(routes.includes("app.get('/api/code/model-assignments'"), 'server must expose assignment read route');
    assert.ok(routes.includes("app.put('/api/code/model-assignments/:role'"), 'server must expose assignment write route');
    assert.ok(routes.includes("app.delete('/api/code/model-assignments/:role'"), 'server must expose assignment clear route');
    assert.ok(routes.includes('modelId') && routes.includes('if (!modelId)'), 'assignment route must keep raw modelId compatibility');
    assert.ok(routes.includes('buildJwcModelRole(provider, model') && routes.includes('thinkingLevel'), 'assignment route must support structured provider/model/thinking body');
    assert.ok(client.includes('listModelAssignments()'), 'client must expose assignment read method');
    assert.ok(client.includes('setModelAssignment(role'), 'client must expose assignment write method');
    assert.ok(client.includes("typeof input === 'string' ? { modelId: input } : input"), 'client must support raw and structured assignment payloads');
    assert.ok(client.includes('clearModelAssignment(role'), 'client must expose assignment clear method');

    const assignmentRouteBlock = routes.slice(
        routes.indexOf("app.get('/api/code/model-assignments'"),
        routes.indexOf("app.get('/api/code/sessions'"),
    );
    assert.equal(assignmentRouteBlock.includes('setSessionModel'), false, 'assignment route must not mutate active session model');
});
