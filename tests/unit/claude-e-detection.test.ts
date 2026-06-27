import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { detectCli, getClaudeExecHelperCandidates, getClaudeIHelperCandidates } from '../../src/core/config.ts';

function writeExecutable(dir: string, name: string): string {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, `#!/usr/bin/env sh
if [ "$1" = "run" ] && [ "$2" = "--help" ]; then
  echo "      --idle-timeout-ms <IDLE_TIMEOUT_MS>"
  echo "      --hard-timeout-ms <HARD_TIMEOUT_MS>"
  exit 0
fi
echo claude-e 0.1.9
`);
    fs.chmodSync(filePath, 0o755);
    return filePath;
}

test('claude-i helper candidates prefer explicit claude-e env override', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-claude-i-project-'));
    const explicit = path.join(projectDir, 'custom-claude-e');
    const execAlias = path.join(projectDir, 'custom-claude-exec');
    const legacy = path.join(projectDir, 'custom-jaw-claude-i');

    const candidates = getClaudeIHelperCandidates(projectDir, {
        CLAUDE_E_BIN: explicit,
        CLAUDE_EXEC_BIN: execAlias,
        JAW_CLAUDE_I_BIN: legacy,
    });

    assert.equal(candidates[0], explicit);
    assert.equal(candidates[1], execAlias);
    assert.equal(candidates[2], legacy);
    assert.ok(candidates.some((candidate) => candidate.includes(path.join('target', 'release'))));
    assert.ok(candidates.some((candidate) => candidate.includes(path.join('target', 'debug'))));
    assert.ok(candidates.some((candidate) => candidate.includes(path.join('native', 'claude-e', 'target', 'release'))));
    assert.ok(candidates.some((candidate) => candidate.includes(path.join('native', 'jaw-claude-i', 'target', 'release'))));
    assert.ok(!candidates.some((candidate) => candidate.includes(path.join('native', 'claude-e', 'target', 'release', 'claude-i'))));
});

test('claude-e helper candidates expose package bins and compatibility aliases', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-claude-e-project-'));
    const explicit = path.join(projectDir, 'custom-claude-e');

    const candidates = getClaudeExecHelperCandidates(projectDir, { CLAUDE_E_BIN: explicit });

    assert.equal(candidates[0], explicit);
    assert.ok(candidates.some((candidate) => candidate.endsWith(path.join('target', 'release', 'claude-e'))));
    assert.ok(candidates.some((candidate) => candidate.endsWith(path.join('target', 'release', 'claude-exec'))));
    assert.ok(candidates.some((candidate) => candidate.endsWith(path.join('target', 'debug', 'claude-e'))));
    assert.ok(candidates.some((candidate) => candidate.endsWith(path.join('target', 'debug', 'claude-exec'))));
});

test('detectCli resolves claude-e through CLAUDE_E_BIN fallback', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-claude-e-bin-'));
    const helperName = process.platform === 'win32' ? 'claude-e.exe' : 'claude-e';
    const helper = writeExecutable(dir, helperName);
    const oldPath = process.env.PATH;
    const oldShortOverride = process.env.CLAUDE_E_BIN;
    const oldExecOverride = process.env.CLAUDE_EXEC_BIN;
    const oldOverride = process.env.JAW_CLAUDE_I_BIN;

    try {
        process.env.PATH = '/usr/bin:/bin';
        process.env.CLAUDE_E_BIN = helper;
        delete process.env.CLAUDE_EXEC_BIN;
        delete process.env.JAW_CLAUDE_I_BIN;
        const detected = detectCli('claude-e');
        assert.equal(detected.available, true);
        assert.equal(detected.path, helper);
    } finally {
        if (oldPath === undefined) delete process.env.PATH;
        else process.env.PATH = oldPath;
        if (oldShortOverride === undefined) delete process.env.CLAUDE_E_BIN;
        else process.env.CLAUDE_E_BIN = oldShortOverride;
        if (oldExecOverride === undefined) delete process.env.CLAUDE_EXEC_BIN;
        else process.env.CLAUDE_EXEC_BIN = oldExecOverride;
        if (oldOverride === undefined) delete process.env.JAW_CLAUDE_I_BIN;
        else process.env.JAW_CLAUDE_I_BIN = oldOverride;
    }
});
