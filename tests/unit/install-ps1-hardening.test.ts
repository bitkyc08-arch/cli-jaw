import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

test('IPS-001: install.ps1 uses catchable terminating errors, not inline exit', () => {
    // #368: the documented invocation is `irm ... | iex`, where `exit 1` can terminate
    // the USER'S shell rather than returning a catchable failure.
    const src = read('scripts/install.ps1');
    assert.match(src, /function Stop-Install/);
    assert.match(src, /throw "CLI-JAW installation failed/);
    const body = src.slice(src.indexOf('function Stop-Install'));
    assert.doesNotMatch(body, /^\s*exit 1\s*$/m, 'no bare `exit 1` may remain in the failure path');
});

test('IPS-002: the Node floor is a full version compare, not a major-only check', () => {
    // A major-only check accepts 22.0-22.3, which are below the package floor.
    const src = read('scripts/install.ps1');
    assert.match(src, /\[version\]'22\.4\.0'/);
    const pkg = JSON.parse(read('package.json'));
    assert.equal(pkg.engines.node, '>=22.4.0', 'installer floor must track package engines');
});

test('IPS-003: npm is resolved as an executable, never npm.ps1', () => {
    // Under a restrictive execution policy npm.ps1 is blocked while npm.cmd works.
    const src = read('scripts/install.ps1');
    assert.match(src, /-CommandType Application/);
    assert.match(src, /Resolve-CommandPath @\('npm\.cmd', 'npm\.exe', 'npm'\)/);
});

test('IPS-004: exit code stays authoritative around native commands', () => {
    // PowerShell 5.1 can promote native stderr to an error record under
    // $ErrorActionPreference='Stop', failing a command that actually succeeded.
    const src = read('scripts/install.ps1');
    assert.match(src, /\$ErrorActionPreference = 'Continue'/);
    assert.match(src, /\$LASTEXITCODE/);
});

test('IPS-005: PATH guidance reads the User target, never the merged process PATH', () => {
    // Serializing $env:Path into the User target copies machine entries into user
    // configuration and leaves permanent duplication.
    const src = read('scripts/install.ps1');
    assert.match(src, /GetEnvironmentVariable\('Path', 'User'\)/);
    assert.doesNotMatch(src, /SetEnvironmentVariable\('Path', "?\$env:Path/);
});

test('IPS-006: follow-up guidance survives a restrictive execution policy', () => {
    const src = read('scripts/install.ps1');
    assert.match(src, /jaw\.cmd doctor/);
    assert.match(src, /jaw\.cmd init/);
});

test('IPS-007: both PowerShell versions run the installer contract in CI', () => {
    const wf = read('.github/workflows/postinstall-platform.yml');
    const idx = wf.indexOf('install-ps1-contract.ps1');
    assert.ok(idx > 0, 'the contract test must run in CI');
    assert.match(wf, /shell: pwsh/);
    assert.match(wf, /shell: powershell/);
    // A lane that is allowed to fail is not a gate.
    assert.doesNotMatch(wf, /continue-on-error/);
});

