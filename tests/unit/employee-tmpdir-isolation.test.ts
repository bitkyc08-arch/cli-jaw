// Employee temp dir isolation: verify spawn.ts creates isolated cwd for employees
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readSrc(rel: string): string {
    return fs.readFileSync(join(__dirname, rel), 'utf8');
}

// ─── Source-level structural checks ─────────────────────

test('TMPISO-001: cleanupEmployeeTmpDir function exists in spawn.ts', () => {
    const src = readSrc('../../src/agent/spawn.ts');
    assert.ok(src.includes('function cleanupEmployeeTmpDir('));
    assert.ok(src.includes('fs.rmSync(cwd'));
});

test('TMPISO-002: isolation block creates temp dir with all instruction files', () => {
    const src = readSrc('../../src/agent/spawn.ts');
    assert.ok(src.includes("jaw-emp-"));
    assert.ok(src.includes("'AGENTS.md'"));
    assert.ok(src.includes("'CLAUDE.md'"));
    assert.ok(src.includes("'GEMINI.md'"));
    assert.ok(src.includes("'CONTEXT.md'"));
    assert.ok(src.includes(".claude"));
});

test('TMPISO-003: spawnCwd is used (not settings.workingDir) for AcpClient', () => {
    const src = readSrc('../../src/agent/spawn.ts');
    // AcpClient should use spawnCwd
    assert.ok(src.includes('workDir: spawnCwd'));
    // There should be no workDir: settings.workingDir for AcpClient
    assert.ok(!src.includes('workDir: settings.workingDir'));
});

test('TMPISO-004: acp.createSession uses spawnCwd (both occurrences)', () => {
    const src = readSrc('../../src/agent/spawn.ts');
    const matches = src.match(/acp\.createSession\(spawnCwd\)/g);
    assert.ok(matches, 'should have acp.createSession(spawnCwd) calls');
    assert.equal(matches.length, 2, 'exactly 2 acp.createSession(spawnCwd) calls');
    // Verify no acp.createSession(settings.workingDir) remains
    assert.ok(!src.includes('acp.createSession(settings.workingDir)'));
});

test('TMPISO-005: child_process spawn uses spawnCwd', () => {
    const src = readSrc('../../src/agent/spawn.ts');
    // Find the spawn() call options — should use spawnCwd for cwd
    // Note: spawn uses spawnCommand (resolved path on non-Windows) instead of raw cli
    const spawnSection = src.slice(src.indexOf('spawn(spawnCommand, args'));
    assert.ok(spawnSection.includes('cwd: spawnCwd'));
});

test('TMPISO-006: cleanup in all exit/error handlers', () => {
    const src = readSrc('../../src/agent/spawn.ts');
    // Count all cleanupEmployeeTmpDir calls (should be at least 5: early return, acp error, acp exit, child error, child close)
    const cleanupCalls = src.match(/cleanupEmployeeTmpDir\(/g);
    assert.ok(cleanupCalls, 'should have cleanup calls');
    assert.ok(cleanupCalls.length >= 5, `expected >= 5 cleanup calls, got ${cleanupCalls.length}`);
});

test('TMPISO-007: cleanup is no-op when cwd === workingDir (main agent)', () => {
    const src = readSrc('../../src/agent/spawn.ts');
    // The guard: if (cwd !== workingDir)
    assert.ok(src.includes('if (cwd !== workingDir)'));
});

test('TMPISO-008: distribute.ts passes sysPrompt unconditionally (not ternary)', () => {
    const src = readSrc('../../src/orchestrator/distribute.ts');
    // Must NOT have: sysPrompt: canResume ? undefined : sysPrompt
    assert.ok(!src.includes('canResume ? undefined : sysPrompt'), 'should not have conditional sysPrompt');
    // Must have: sysPrompt: sysPrompt (or shorthand sysPrompt,)
    assert.ok(src.includes('sysPrompt: sysPrompt') || src.includes('sysPrompt,'), 'should pass sysPrompt unconditionally');
});

// ─── Functional: temp dir lifecycle ─────────────────────

test('TMPISO-010: temp dir creation and cleanup works end-to-end', () => {
    const label = 'test-emp';
    const workingDir = '/fake/working/dir';
    const tmpDir = join(os.tmpdir(), `jaw-emp-${label}-${Date.now()}`);

    // Create like spawn.ts does
    fs.mkdirSync(tmpDir, { recursive: true });
    for (const name of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'CONTEXT.md']) {
        fs.writeFileSync(join(tmpDir, name), 'TEST_EMPLOYEE_PROMPT');
    }
    const dotClaudeDir = join(tmpDir, '.claude');
    fs.mkdirSync(dotClaudeDir, { recursive: true });
    fs.writeFileSync(join(dotClaudeDir, 'CLAUDE.md'), 'TEST_EMPLOYEE_PROMPT');

    // Verify all files exist
    assert.ok(fs.existsSync(join(tmpDir, 'AGENTS.md')));
    assert.ok(fs.existsSync(join(tmpDir, 'CLAUDE.md')));
    assert.ok(fs.existsSync(join(tmpDir, 'GEMINI.md')));
    assert.ok(fs.existsSync(join(tmpDir, 'CONTEXT.md')));
    assert.ok(fs.existsSync(join(tmpDir, '.claude', 'CLAUDE.md')));

    // Verify content
    assert.equal(fs.readFileSync(join(tmpDir, 'AGENTS.md'), 'utf8'), 'TEST_EMPLOYEE_PROMPT');
    assert.equal(fs.readFileSync(join(tmpDir, '.claude', 'CLAUDE.md'), 'utf8'), 'TEST_EMPLOYEE_PROMPT');

    // Cleanup like cleanupEmployeeTmpDir does
    const cwd = tmpDir;
    if (cwd !== workingDir) {
        fs.rmSync(cwd, { recursive: true, force: true });
    }

    // Verify cleaned up
    assert.ok(!fs.existsSync(tmpDir), 'temp dir should be removed after cleanup');
});

test('TMPISO-011: cleanup is skipped when cwd === workingDir', () => {
    const tmpDir = join(os.tmpdir(), `jaw-emp-test-noclean-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(join(tmpDir, 'test.txt'), 'should survive');

    // Simulate: cwd === workingDir → no cleanup
    const cwd = tmpDir;
    const workingDir = tmpDir; // same!
    if (cwd !== workingDir) {
        fs.rmSync(cwd, { recursive: true, force: true });
    }

    // Should still exist
    assert.ok(fs.existsSync(tmpDir), 'should NOT clean when cwd === workingDir');

    // Manual cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
});
