import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..', '..');

// ── RH-001: package.json files에 skills_ref/ 미포함 ──

test('RH-001: package.json files array does not include skills_ref', () => {
    const pkg = JSON.parse(fs.readFileSync(join(root, 'package.json'), 'utf8'));
    const hasSkillsRef = (pkg.files || []).some((f: string) => f.includes('skills_ref'));
    assert.ok(!hasSkillsRef, 'skills_ref should not be in package.json files');
});

// ── RH-002: .npmignore에 skills_ref/ 포함 ──

test('RH-002: .npmignore excludes skills_ref', () => {
    const npmignore = fs.readFileSync(join(root, '.npmignore'), 'utf8');
    assert.ok(npmignore.includes('skills_ref'), '.npmignore should exclude skills_ref');
});

// ── RH-003: .npmignore에 devlog/ 포함 ──

test('RH-003: .npmignore excludes devlog', () => {
    const npmignore = fs.readFileSync(join(root, '.npmignore'), 'utf8');
    assert.ok(npmignore.includes('devlog'), '.npmignore should exclude devlog');
});

// ── RH-004: tests/phase-100/ 디렉토리 미존재 ──

test('RH-004: tests/phase-100 directory does not exist', () => {
    assert.ok(!fs.existsSync(join(root, 'tests', 'phase-100')), 'phase-100 should be removed');
});

// ── RH-005: employee-session-reuse.test.ts가 tests/unit/에 존재 ──

test('RH-005: employee-session-reuse.test.ts exists in tests/unit', () => {
    assert.ok(
        fs.existsSync(join(root, 'tests', 'unit', 'employee-session-reuse.test.ts')),
        'should be moved to tests/unit',
    );
});

// ── RH-006: stale legacy dist artifact is excluded from npm package ──

test('RH-006: .npmignore excludes dist/bin/cli-claw.js', () => {
    const npmignore = fs.readFileSync(join(root, '.npmignore'), 'utf8');
    assert.ok(
        npmignore.includes('dist/bin/cli-claw.js'),
        '.npmignore should exclude stale legacy dist/bin/cli-claw.js',
    );
    assert.ok(
        npmignore.includes('dist/bin/cli-claw.js.map'),
        '.npmignore should exclude stale legacy dist/bin/cli-claw.js.map',
    );
});

// ── RH-007: build script cleans dist before tsc ──

test('RH-007: package build runs clean:dist before tsc', () => {
    const pkg = JSON.parse(fs.readFileSync(join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts?.build, 'npm run clean:dist && tsc');
});
