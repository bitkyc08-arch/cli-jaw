/**
 * Scriptless install contract — 260804 install hardening.
 *
 * The strongest fix for npm 12's default-deny is not needing install scripts
 * at all. better-sqlite3 >= 13 ships Node-API prebuilds inside the package;
 * dropping back to 12.x silently reintroduces the blocked-build failure this
 * unit was created to fix. Cypress shipped a broken array-form allowScripts
 * and had to revert — the boolean-map check pins that lesson too.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    allowScripts?: unknown;
};

test('better-sqlite3 range excludes script-dependent 12.x', () => {
    const range = pkg.dependencies?.['better-sqlite3'] ?? '';
    const major = Number(/(\d+)/.exec(range)?.[1] ?? 0);
    assert.ok(major >= 13,
        `better-sqlite3 must stay >= 13 (scriptless prebuilds); found "${range}"`);
});

test('package.json allowScripts is a boolean map, not an array', () => {
    if (pkg.allowScripts === undefined) return; // absent is fine
    assert.ok(!Array.isArray(pkg.allowScripts), 'allowScripts array form does not work (Cypress regression)');
    assert.equal(typeof pkg.allowScripts, 'object');
    for (const [name, value] of Object.entries(pkg.allowScripts as Record<string, unknown>)) {
        assert.equal(typeof value, 'boolean', `allowScripts["${name}"] must be a boolean`);
    }
});

test('installed better-sqlite3 has no install/postinstall script', () => {
    const manifestPath = path.join(projectRoot, 'node_modules', 'better-sqlite3', 'package.json');
    if (!fs.existsSync(manifestPath)) return; // dependency not installed in this env
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { scripts?: Record<string, string> };
    assert.equal(manifest.scripts?.['install'], undefined, 'v13 must not have an install script');
    assert.equal(manifest.scripts?.['postinstall'], undefined, 'v13 must not have a postinstall script');
    assert.ok(manifest.scripts?.['build-release'], 'v13 source-build fallback script must exist (ensure-native uses it)');
});

test('installed better-sqlite3 ships a prebuild for this platform', () => {
    const prebuilds = path.join(projectRoot, 'node_modules', 'better-sqlite3', 'prebuilds');
    if (!fs.existsSync(path.join(projectRoot, 'node_modules', 'better-sqlite3'))) return;
    assert.ok(fs.existsSync(prebuilds), 'prebuilds/ missing — is better-sqlite3 < 13 installed?');
    const platformKey = process.platform === 'linux' ? 'linux' : process.platform;
    const match = fs.readdirSync(prebuilds).some(f => f.startsWith(platformKey) && f.includes(process.arch));
    assert.ok(match, `no prebuild for ${process.platform}-${process.arch}`);
});

test('claude-e is not bundled in any dependency block', () => {
    assert.equal(pkg.dependencies?.['claude-e'], undefined);
    assert.equal(pkg.optionalDependencies?.['claude-e'], undefined);
});

test('ensure-native picks the script by manifest, not a hardcoded name', () => {
    const source = fs.readFileSync(path.join(projectRoot, 'scripts', 'ensure-native-modules.cjs'), 'utf8');
    assert.ok(source.includes('build-release'), 'v13 fallback script missing from ensure-native');
    assert.ok(/scripts\.install\s*\?\s*'install'\s*:\s*'build-release'/.test(source),
        'ensure-native must branch on the installed manifest');
});

test('bundle-sidecar skips the rebuild loop for v13 and keeps a source-build fallback', () => {
    const source = fs.readFileSync(path.join(projectRoot, 'scripts', 'bundle-sidecar.sh'), 'utf8');
    assert.ok(source.includes('skip rebuild (v13+ bundled prebuilds)'), 'v13 skip branch missing');
    assert.ok(source.includes('build-release'), 'v13 source-build fallback missing');
    assert.ok(source.includes('.jaw-install-state.json'), 'sidecar receipt missing');
    assert.ok(source.includes('"sidecar": true') || source.includes('sidecar: true'),
        'sidecar receipt must be marked as sidecar');
});

test('install-state receipt never ships in the tarball (files allowlist)', () => {
    const files = (JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as { files?: string[] }).files ?? [];
    assert.ok(!files.some(f => f.includes('.jaw-install-state')), 'receipt must not be in files allowlist');
    // Root-level dotfiles outside `files` are excluded automatically; pin that
    // the receipt path is root-level (not under dist/, which IS shipped).
    const guardSource = fs.readFileSync(path.join(projectRoot, 'scripts', 'postinstall-guard.cjs'), 'utf8');
    assert.ok(!/dist[\\/'"]+\.?[^'"]*postinstall-receipt/.test(guardSource), 'receipt must not live under dist/');
});

test('installer scripts attach --allow-scripts conditionally', () => {
    for (const script of ['install.sh', 'install-wsl.sh']) {
        const source = fs.readFileSync(path.join(projectRoot, 'scripts', script), 'utf8');
        assert.ok(source.includes('jaw_npm_supports_allow_scripts'), `${script}: npm version gate missing`);
        assert.ok(source.includes('--allow-scripts=${JAW_ALLOW_SCRIPTS}'), `${script}: allow-scripts flag missing`);
        assert.ok(source.includes('allow_flag'), `${script}: computed flag must actually be used`);
    }
});

test('install.ps1 contract: no policy mutation, no elevation, PATH guidance, version gate', () => {
    const source = fs.readFileSync(path.join(projectRoot, 'scripts', 'install.ps1'), 'utf8');
    assert.ok(!source.includes('Set-ExecutionPolicy'), 'must not change execution policy');
    assert.ok(!/#Requires\s+-RunAsAdministrator/i.test(source), 'must not require elevation');
    assert.ok(source.includes('Set-StrictMode -Version Latest'));
    assert.ok(source.includes('SetEnvironmentVariable'), 'must print (not run silently) the PATH fix');
    assert.ok(source.includes('--allow-scripts=$JawAllowScripts'), 'allow-scripts version gate missing');
    assert.ok(source.includes('-TarballPath') || source.includes('$TarballPath'), 'CI tarball arg missing');
});
