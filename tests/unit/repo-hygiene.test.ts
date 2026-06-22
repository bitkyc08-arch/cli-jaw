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

// ── RH-006b: stale nested frontend build output is excluded from npm package ──

test('RH-006b: .npmignore excludes nested frontend build artifacts', () => {
    const npmignore = fs.readFileSync(join(root, '.npmignore'), 'utf8');
    const publicNpmignore = fs.readFileSync(join(root, 'public', '.npmignore'), 'utf8');
    assert.ok(
        npmignore.includes('public/public/'),
        '.npmignore should exclude stale Vite publicDir output',
    );
    assert.ok(
        npmignore.includes('public/dist/dist/'),
        '.npmignore should exclude stale nested frontend dist output',
    );
    assert.ok(
        publicNpmignore.includes('public/'),
        'public/.npmignore should prune public/public/ when package.json files includes public/',
    );
    assert.ok(
        publicNpmignore.includes('dist/dist/'),
        'public/.npmignore should prune public/dist/dist/ when package.json files includes public/',
    );
});

// ── RH-007: build is race-free for concurrent server reads ──
//
// Build compiles to .dist-staging/ then swaps into dist/ with rollback.
// Copies template/prompt dirs from fresh staging without destructive clean:dist.
test('RH-007: build avoids destructive clean:dist (staged template copy)', () => {
    const pkg = JSON.parse(fs.readFileSync(join(root, 'package.json'), 'utf8'));
    const build = pkg.scripts?.build || '';
    assert.ok(!build.startsWith('npm run clean:dist'), 'build must NOT lead with clean:dist (races with running server)');
    let buildContent = build;
    const scriptMatch = build.match(/bash\s+(\S+)/);
    if (scriptMatch) {
        const scriptPath = join(root, scriptMatch[1]);
        if (fs.existsSync(scriptPath)) buildContent = fs.readFileSync(scriptPath, 'utf8');
    }
    assert.ok(buildContent.includes('tsc'), 'build must still invoke tsc');
    assert.ok(buildContent.includes('cp -R'), 'build must copy templates from a fresh staging directory');
});

// ── RH-008: Electron desktop app stays out of the npm CLI package ──

test('RH-008: root npm package stays lean and excludes Electron app/deps', () => {
    const pkg = JSON.parse(fs.readFileSync(join(root, 'package.json'), 'utf8'));
    const files = pkg.files || [];
    const dependencyMaps = [
        pkg.dependencies || {},
        pkg.devDependencies || {},
        pkg.optionalDependencies || {},
        pkg.peerDependencies || {},
    ];
    const hasElectronDep = dependencyMaps.some((deps: Record<string, string>) => Object.hasOwn(deps, 'electron'));
    const includesElectronApp = files.some((entry: string) => entry === 'electron' || entry.startsWith('electron/'));

    assert.equal(hasElectronDep, false, 'root package.json must not depend on electron');
    assert.equal(includesElectronApp, false, 'published npm files must not include electron/');
    assert.deepEqual(files, ['dist/', '!dist/src/lib/native/*.node', 'public/', 'scripts/', 'package.json']);
});
