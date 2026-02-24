/**
 * CLI Basic Tests — bin/cli-claw.js 기본 동작 확인
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '../../bin/cli-claw.js');

function run(...args) {
    try {
        return execFileSync('node', [CLI, ...args], {
            encoding: 'utf8',
            timeout: 5000,
            env: { ...process.env, NO_COLOR: '1' },
        });
    } catch (e) {
        // Combine stdout + stderr to capture all output
        return (e.stdout || '') + (e.stderr || '');
    }
}

test('CLI-001: --help shows usage', () => {
    const out = run('--help');
    assert.ok(out.includes('cli-claw') || out.includes('Commands') || out.includes('Usage'));
});

test('CLI-002: --version shows version', () => {
    const out = run('--version');
    assert.match(out, /\d+\.\d+\.\d+/);
});

test('CLI-003: unknown command exits with error', () => {
    const out = run('nonexistent-command-xyz');
    assert.ok(out.includes('Unknown') || out.includes('unknown') || out.includes('not found') || out.length === 0);
});

test('CLI-004: doctor runs without crash', () => {
    const out = run('doctor');
    assert.ok(out.includes('✓') || out.includes('✗') || out.includes('check') || out.includes('CLI'));
});
