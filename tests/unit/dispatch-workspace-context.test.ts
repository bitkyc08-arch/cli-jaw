import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    buildResolvedPathHints,
    buildWorkspaceContextBlock,
    resolveWorkspaceRoot,
} from '../../src/orchestrator/workspace-context.ts';

const distributeSrc = readFileSync(
    join(import.meta.dirname, '../../src/orchestrator/distribute.ts'),
    'utf8',
);

test('workspace context block includes authoritative project paths and cwd warning', () => {
    const root = mkdtempSync(join(tmpdir(), 'jaw-workspace-context-'));
    const block = buildWorkspaceContextBlock({
        workingDir: root,
        worklogPath: join(root, 'devlog/worklog.md'),
        task: 'check src/orchestrator/distribute.ts and devlog/structure',
    });

    assert.ok(block.includes('## Workspace Context (authoritative)'));
    assert.ok(block.includes(`Project root: ${root}`));
    assert.ok(block.includes(`Devlog root: ${join(root, 'devlog')}`));
    assert.ok(block.includes(`Worklog path: ${join(root, 'devlog/worklog.md')}`));
    assert.ok(block.includes('Employee runtime cwd: isolated temporary directory'));
    assert.ok(block.includes('Do not infer repository paths from process.cwd()'));
});

test('resolved path hints map repo-relative paths to absolute project paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'jaw-path-hints-'));
    mkdirSync(join(root, 'src/orchestrator'), { recursive: true });
    writeFileSync(join(root, 'src/orchestrator/distribute.ts'), '');

    const hints = buildResolvedPathHints(
        'read src/orchestrator/distribute.ts and tests/unit/missing.test.ts',
        root,
    );

    assert.ok(hints.includes('## Resolved Path Hints'));
    assert.ok(hints.includes(`src/orchestrator/distribute.ts -> ${join(root, 'src/orchestrator/distribute.ts')} (exists)`));
    assert.ok(hints.includes(`tests/unit/missing.test.ts -> ${join(root, 'tests/unit/missing.test.ts')} (not found)`));
});

test('resolveWorkspaceRoot falls back to process cwd when workingDir is empty', () => {
    assert.equal(resolveWorkspaceRoot('').startsWith('/'), true);
    assert.equal(resolveWorkspaceRoot(null).startsWith('/'), true);
});

test('runSingleAgent injects workspace context before task instruction and env', () => {
    assert.ok(distributeSrc.includes("import { settings } from '../core/config.js';"));
    assert.ok(distributeSrc.includes("import { buildWorkspaceContextBlock } from './workspace-context.js';"));
    assert.ok(distributeSrc.includes('const workspaceBlock = buildWorkspaceContextBlock({'));
    assert.ok(distributeSrc.includes('workingDir: settings.workingDir || null'));
    assert.ok(distributeSrc.includes('task: ap.task'));
    assert.ok(distributeSrc.includes('const taskPrompt = `${workspaceBlock}'));
    assert.ok(distributeSrc.includes('## Task Instruction [${phaseLabel}]'));
    assert.ok(distributeSrc.indexOf('const taskPrompt = `${workspaceBlock}') <
        distributeSrc.indexOf('## Task Instruction [${phaseLabel}]'));
    assert.ok(distributeSrc.includes('workspaceContext: workspaceBlock'));
    assert.ok(distributeSrc.includes('JAW_WORKSPACE_ROOT: settings.workingDir ||'));
    assert.ok(distributeSrc.includes('JAW_WORKLOG_PATH: worklogPath ||'));
});
