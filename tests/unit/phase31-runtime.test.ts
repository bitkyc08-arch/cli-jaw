import { readSource } from './source-normalize.js';
// Phase 3.1 runtime safeguards: startup migration + workingDir artifact regeneration
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const serverSrc = readSource(join(projectRoot, 'server.ts'), 'utf8');
const runtimeSettingsSrc = readSource(join(projectRoot, 'src/core/runtime-settings.ts'), 'utf8');
const builderSrc = readSource(join(projectRoot, 'src/prompt/builder.ts'), 'utf8');

function section(src: string, startMarker: string, endMarker: string) {
    const start = src.indexOf(startMarker);
    const end = src.indexOf(endMarker);
    if (start === -1 || end === -1 || end <= start) return '';
    return src.slice(start, end);
}

test('P31-001: startup migrates permissions safe -> auto', () => {
    assert.match(
        serverSrc,
        /if\s*\(\s*settings\.permissions\s*===\s*['"]safe['"]\s*\)\s*{[\s\S]*settings\.permissions\s*=\s*['"]auto['"][\s\S]*saveSettings\(settings\)/,
    );
});

// The literal used to be `settings.workingDir`; it now reads from the snapshot
// taken before the merge, which is the same guarantee expressed more precisely.
// Pin the guarantee rather than the spelling: the previous value must be
// captured before the patch is applied, so a workingDir change is still
// detectable afterwards.
test('P31-002: applySettingsPatch tracks previous workingDir before merge', () => {
    assert.match(runtimeSettingsSrc, /const prevWorkingDir = prevSnapshot(\.workingDir|\[["']workingDir["']\])/);
    const captureIndex = runtimeSettingsSrc.indexOf('const prevWorkingDir');
    const compareIndex = runtimeSettingsSrc.indexOf('!== prevWorkingDir');
    assert.ok(captureIndex > 0 && compareIndex > captureIndex,
        'the previous workingDir must be captured before it is compared');
});

test('P31-003: workingDir change triggers artifact regeneration pipeline', () => {
    assert.ok(runtimeSettingsSrc.includes('if (settings.workingDir !== prevWorkingDir)'));
    assert.ok(runtimeSettingsSrc.includes('initMcpConfig(settings.workingDir)'));
    assert.ok(runtimeSettingsSrc.includes('ensureWorkingDirSkillsLinks(settings.workingDir'));
    assert.ok(runtimeSettingsSrc.includes('syncToAll(loadUnifiedMcp())'));
    assert.ok(runtimeSettingsSrc.includes('regenerateB()'));
});

test('P31-004: regenerateB clears both template cache and prompt cache', () => {
    const body = section(builderSrc, 'export function regenerateB()', '// Generate {workDir}/AGENTS.md');
    assert.ok(body.includes('clearTemplateCache()'));
    assert.ok(body.includes('clearPromptCache()'));
});
