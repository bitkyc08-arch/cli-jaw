// Phase 3.1 runtime safeguards: startup migration + workingDir artifact regeneration
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const serverSrc = readFileSync(join(projectRoot, 'server.ts'), 'utf8');
const runtimeSettingsSrc = readFileSync(join(projectRoot, 'src/core/runtime-settings.ts'), 'utf8');

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

test('P31-002: applySettingsPatch tracks previous workingDir before merge', () => {
    assert.ok(runtimeSettingsSrc.includes('const prevWorkingDir = settings.workingDir'));
});

test('P31-003: workingDir change triggers artifact regeneration pipeline', () => {
    assert.ok(runtimeSettingsSrc.includes('if (settings.workingDir !== prevWorkingDir)'));
    assert.ok(runtimeSettingsSrc.includes('initMcpConfig(settings.workingDir)'));
    assert.ok(runtimeSettingsSrc.includes('ensureWorkingDirSkillsLinks(settings.workingDir'));
    assert.ok(runtimeSettingsSrc.includes('syncToAll(loadUnifiedMcp())'));
    assert.ok(runtimeSettingsSrc.includes('regenerateB()'));
});
