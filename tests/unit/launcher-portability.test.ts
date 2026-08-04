import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const projectRoot = join(import.meta.dirname, '..', '..');
const launcherSource = join(projectRoot, 'bin', 'jaw');

/**
 * Build a throwaway installation whose directory name contains a space AND an
 * apostrophe — the exact shape that used to break the launcher, because the
 * install path was interpolated into JavaScript source passed to `node -e`.
 */
function stageInstall(): { root: string; installDir: string } {
    const root = mkdtempSync(join(tmpdir(), 'jaw-launcher-'));
    const installDir = join(root, "it's dir");
    mkdirSync(join(installDir, 'bin'), { recursive: true });
    mkdirSync(join(installDir, 'dist', 'bin'), { recursive: true });
    mkdirSync(join(installDir, 'scripts'), { recursive: true });

    copyFileSync(launcherSource, join(installDir, 'bin', 'jaw'));
    chmodSync(join(installDir, 'bin', 'jaw'), 0o755);
    copyFileSync(
        join(projectRoot, 'scripts', 'ensure-native-modules.cjs'),
        join(installDir, 'scripts', 'ensure-native-modules.cjs'),
    );
    copyFileSync(join(projectRoot, 'package.json'), join(installDir, 'package.json'));
    symlinkSync(join(projectRoot, 'node_modules'), join(installDir, 'node_modules'));
    writeFileSync(
        join(installDir, 'dist', 'bin', 'cli-jaw.js'),
        'console.log("CLI_RAN cwd=" + process.cwd());\n',
    );

    return { root, installDir };
}

function runLauncher(launcher: string, cwd: string): { stdout: string; status: number } {
    try {
        const stdout = execFileSync('/bin/sh', [launcher], { cwd, encoding: 'utf8', stdio: 'pipe' });
        return { stdout, status: 0 };
    } catch (error) {
        const err = error as { stdout?: string; stderr?: string; status?: number };
        return { stdout: `${err.stdout ?? ''}${err.stderr ?? ''}`, status: err.status ?? 1 };
    }
}

test('launcher starts from a path containing a space and an apostrophe', () => {
    const { root, installDir } = stageInstall();
    try {
        const result = runLauncher(join(installDir, 'bin', 'jaw'), tmpdir());

        assert.equal(result.status, 0, result.stdout);
        assert.match(result.stdout, /CLI_RAN/);
        assert.doesNotMatch(result.stdout, /SyntaxError/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('launcher resolves itself through a symlink without readlink -f', () => {
    const { root, installDir } = stageInstall();
    try {
        const linkDir = join(root, 'link');
        mkdirSync(linkDir);
        const link = join(linkDir, 'jaw');
        symlinkSync(join(installDir, 'bin', 'jaw'), link);

        const result = runLauncher(link, tmpdir());
        assert.equal(result.status, 0, result.stdout);
        assert.match(result.stdout, /CLI_RAN/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('launcher preserves the caller working directory', () => {
    const { root, installDir } = stageInstall();
    try {
        const callerCwd = mkdtempSync(join(tmpdir(), 'jaw-caller-'));
        try {
            const result = runLauncher(join(installDir, 'bin', 'jaw'), callerCwd);

            assert.equal(result.status, 0, result.stdout);
            // The recovery branch used to `cd` in the current shell, so the CLI
            // silently inherited the install directory as its cwd.
            assert.doesNotMatch(result.stdout, /CLI_RAN cwd=.*it's dir/);
        } finally {
            rmSync(callerCwd, { recursive: true, force: true });
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('launcher refuses to exec the CLI when native repair fails', () => {
    const { root, installDir } = stageInstall();
    try {
        // Replace the dependency tree with an empty one so repair cannot succeed.
        rmSync(join(installDir, 'node_modules'), { recursive: true, force: true });
        mkdirSync(join(installDir, 'node_modules'));

        const result = runLauncher(join(installDir, 'bin', 'jaw'), tmpdir());

        assert.notEqual(result.status, 0, 'a failed repair must not exit 0');
        assert.doesNotMatch(result.stdout, /CLI_RAN/, 'CLI must not run after a failed repair');
        assert.match(result.stdout, /npm install/, 'user needs an actionable hint');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('launcher never interpolates the install path into JavaScript source', () => {
    const src = readFileSync(launcherSource, 'utf8');
    // Strip comments so the rules documented in this file's header are not
    // mistaken for the code they prohibit.
    const code = src
        .split('\n')
        .filter(line => !line.trimStart().startsWith('#'))
        .join('\n');

    assert.doesNotMatch(code, /require\('\$DIR/, 'path must be passed via argv, not embedded in JS');
    assert.doesNotMatch(code, /readlink -f/, 'the -f flag is a GNU extension, absent on stock macOS/BSD');
    assert.match(code, /process\.argv\[1\]/, 'paths must arrive as argv');
});
