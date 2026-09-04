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

// ── RH-009: the npm description's skill counts must be true (#524) ──
//
// The published blurb claimed "107 built-in skills", a number matching nothing on
// disk. Both counts are recomputed here the way an install computes them, not read
// from a set that install MUTATES: skills-distribution.ts adds every registry entry
// with category 'orchestration' to OPENCLAW_ACTIVE at copy time, so importing that
// singleton yields 18 or 33 depending on what else touched it first in the same
// process. Deriving the union instead makes this test independent of process order.

test('RH-009: the package description reports the real skill counts', () => {
    const pkg = JSON.parse(fs.readFileSync(join(root, 'package.json'), 'utf8'));
    const description: string = pkg.description || '';

    const registryPath = join(root, 'skills_ref', 'registry.json');
    if (!fs.existsSync(registryPath)) return; // skills_ref is a submodule; absent in some checkouts
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const skills: Record<string, { category?: string }> = registry.skills || {};

    const utils = fs.readFileSync(join(root, 'lib', 'mcp', 'skills-utils.ts'), 'utf8');
    const staticIds = (name: string): string[] => {
        const start = utils.indexOf(`export const ${name} = new Set([`);
        if (start < 0) return [];
        const body = utils.slice(start, utils.indexOf(']', start));
        return [...body.matchAll(/'([^']+)'/g)].map(m => m[1] as string);
    };
    const autoActivate = new Set([
        ...staticIds('CODEX_ACTIVE'),
        ...staticIds('OPENCLAW_ACTIVE'),
        ...Object.entries(skills).filter(([, meta]) => meta?.category === 'orchestration').map(([id]) => id),
    ]);
    const referenceSkills = Object.keys(skills)
        .filter(id => fs.existsSync(join(root, 'skills_ref', id, 'SKILL.md')));

    assert.ok(autoActivate.size > 0, 'the auto-activate set must be derivable, or this test proves nothing');

    const claimed = [...description.matchAll(/(\d+)[- ]skill|(\d+) skills/g)]
        .map(m => Number(m[1] ?? m[2]));
    assert.ok(claimed.includes(autoActivate.size),
        `description must state the real auto-activate count (${autoActivate.size}); got ${JSON.stringify(claimed)}`);
    assert.ok(claimed.some(n => n <= referenceSkills.length && n > referenceSkills.length - 10),
        `description must state the reference-library size near ${referenceSkills.length}; got ${JSON.stringify(claimed)}`);
    assert.ok(!/built-in skills/.test(description),
        'skills_ref is npmignored and cloned at install, so they are not "built-in"');
});
