import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSource } from './source-normalize.js';
import {
    buildResolvedPathHints,
    buildWorkspaceContextBlock,
    resolveWorkspaceRoot,
} from '../../src/orchestrator/workspace-context.ts';

const distributeSrc = readSource(
    join(import.meta.dirname, '../../src/orchestrator/distribute.ts'),
);

test('workspace context block includes authoritative project paths and cwd warning', () => {
    const root = mkdtempSync(join(tmpdir(), 'jaw-workspace-context-'));
    const block = buildWorkspaceContextBlock({
        workingDir: root,
        worklogPath: join(root, '..', 'execution-records', 'worklog.md'),
        task: 'check src/orchestrator/distribute.ts',
        now: new Date('2026-06-10T16:40:00.000Z'),
    });

    assert.ok(block.includes('## Workspace Context (authoritative)'));
    assert.ok(block.includes(`Project root: ${JSON.stringify(root)}`));
    assert.match(block, /Current time: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/);
    assert.match(block, /Timezone: \S+/);
    assert.ok(block.includes('UTC time: 2026-06-10T16:40:00.000Z'));
    assert.ok(block.includes(`Worklog path: ${join(root, '..', 'execution-records', 'worklog.md')}`));
    assert.ok(!block.includes('Devlog root:'));
    assert.ok(!block.includes(join(root, 'devlog')));
    assert.ok(block.includes('Employee runtime cwd: isolated temporary directory'));
    assert.ok(block.includes('Do not infer repository paths from process.cwd()'));
});

test('workspace context without a worklog leaves record placement to project policy', () => {
    const block = buildWorkspaceContextBlock({ projectDirs: ['/project-one', '/project-two'] });
    assert.ok(block.includes('Worklog path: (none)'));
    assert.ok(block.includes('follow project policy'));
    assert.ok(!block.includes('Devlog root:'));
    assert.ok(!block.includes('/project-one/devlog'));
    assert.ok(!block.includes('/project-two/devlog'));
});

test('resolved path hints map repo-relative paths to absolute project paths', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'jaw-path-hints-')));
    mkdirSync(join(root, 'src/orchestrator'), { recursive: true });
    writeFileSync(join(root, 'src/orchestrator/distribute.ts'), '');

    const hints = buildResolvedPathHints(
        'read src/orchestrator/distribute.ts and tests/unit/missing.test.ts',
        [root],
    );

    assert.ok(hints.includes('## Resolved Path Hints'));
    assert.ok(hints.includes(`src/orchestrator/distribute.ts -> ${JSON.stringify(join(root, 'src/orchestrator/distribute.ts'))} (exists)`));
    assert.ok(hints.includes(`tests/unit/missing.test.ts -> ${JSON.stringify(join(root, 'tests/unit/missing.test.ts'))} (not found)`));
});

test('resolveWorkspaceRoot falls back to process cwd when workingDir is empty', () => {
    assert.equal(resolveWorkspaceRoot('').startsWith('/'), true);
    assert.equal(resolveWorkspaceRoot(null).startsWith('/'), true);
});

test('runSingleAgent injects workspace context before task instruction and env', () => {
    assert.ok(distributeSrc.includes("{ settings, normalizeProjectDirs } from '../core/config.js'"));
    assert.ok(distributeSrc.includes("import { buildWorkspaceContextBlock } from './workspace-context.js';"));
    assert.ok(distributeSrc.includes('const workspaceBlock = buildWorkspaceContextBlock({'));
    assert.ok(distributeSrc.includes('workingDir: settings.workingDir || null'));
    assert.ok(distributeSrc.includes('task: text(ap.task)'));
    assert.ok(distributeSrc.includes('const taskPrompt = `${workspaceBlock}'));
    assert.ok(distributeSrc.includes('## Task Instruction [${phaseLabel}]'));
    assert.ok(distributeSrc.indexOf('const taskPrompt = `${workspaceBlock}') <
        distributeSrc.indexOf('## Task Instruction [${phaseLabel}]'));
    assert.ok(distributeSrc.includes('workspaceContext: workspaceBlock'));
    assert.ok(distributeSrc.includes('JAW_WORKSPACE_ROOT: effectiveDirs?.[0] || settings.workingDir ||'));
    assert.ok(distributeSrc.includes('JAW_WORKLOG_PATH: worklogPath ||'));
});
