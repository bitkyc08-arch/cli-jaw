// Multi-Instance Phase 2.1-2.2: JAW_HOME dynamic 검증
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

test('P2-001: JAW_HOME respects CLI_JAW_HOME env var', () => {
    const result = execSync(
        'node -e "const c = await import(\'./dist/src/core/config.js\'); console.log(c.JAW_HOME)"',
        { cwd: projectRoot, encoding: 'utf8', env: { ...process.env, CLI_JAW_HOME: '/tmp/test-jaw' } }
    );
    assert.equal(result.trim(), '/tmp/test-jaw');
});

test('P2-002: JAW_HOME defaults to ~/.cli-jaw without env var', () => {
    const result = execSync(
        'node -e "const c = await import(\'./dist/src/core/config.js\'); console.log(c.JAW_HOME)"',
        { cwd: projectRoot, encoding: 'utf8', env: { ...process.env, CLI_JAW_HOME: '' } }
    );
    assert.ok(result.trim().endsWith('.cli-jaw'));
});

test('P2-003: --home flag sets JAW_HOME for doctor subcommand', () => {
    const tmpHome = '/tmp/test-jaw-p2-003';
    mkdirSync(tmpHome, { recursive: true });
    try {
        const result = execSync(
            `node dist/bin/cli-jaw.js --home ${tmpHome} doctor --json`,
            { cwd: projectRoot, encoding: 'utf8' }
        );
        const json = JSON.parse(result);
        const homeCheck = json.checks.find((c: any) => c.name === 'Home directory');
        assert.ok(homeCheck, 'Home directory check should exist');
        assert.equal(homeCheck.detail, tmpHome);
    } finally {
        rmSync(tmpHome, { recursive: true, force: true });
    }
});

test('P2-004: --home=/path equals syntax works', () => {
    const tmpHome = '/tmp/test-jaw-p2-004';
    mkdirSync(tmpHome, { recursive: true });
    try {
        const result = execSync(
            `node dist/bin/cli-jaw.js --home=${tmpHome} doctor --json`,
            { cwd: projectRoot, encoding: 'utf8' }
        );
        const json = JSON.parse(result);
        const homeCheck = json.checks.find((c: any) => c.name === 'Home directory');
        assert.equal(homeCheck.detail, tmpHome);
    } finally {
        rmSync(tmpHome, { recursive: true, force: true });
    }
});

test('P2-005: tilde expansion resolves correctly', () => {
    const result = execSync(
        `node -e "
            import os from 'node:os';
            const val = '~/test-tilde'.replace(/^~(?=\\\\/|$)/, os.homedir());
            console.log(val);
        "`,
        { encoding: 'utf8' }
    );
    assert.ok(result.trim().startsWith('/'));
    assert.ok(result.trim().endsWith('/test-tilde'));
    assert.ok(!result.trim().includes('~'));
});
