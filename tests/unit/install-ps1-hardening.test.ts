import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
// install.ps1 is CRLF (Windows PowerShell 5.1 reads it as ANSI without a BOM), so
// normalize before any line-oriented assertion — a mutation once survived because a
// trailing \r kept the pattern from matching.
const read = (p: string) => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n');
const installer = () => read('scripts/install.ps1');

/**
 * Structural guards for the #368 installer hardening.
 *
 * HONEST SCOPE — read before trusting these. PowerShell cannot run on the macOS host
 * that maintains this repo, so these tests CANNOT execute install.ps1. Behavior is
 * proven by tests/windows/install-ps1-contract.ps1 in the Windows CI lane; these are
 * the cheap regression net for the machine most edits are made on.
 *
 * An adversarial review showed the first draft was worthless: every property admitted
 * a mutation that broke behavior while leaving the matched string intact (keep a dead
 * `throw` and call `exit 2`; keep the 22.4.0 constant and compare `.Major`; keep the
 * User-PATH getter and print an `$env:Path` setter). So each test below now inspects
 * the OPERATIVE construct — the comparison, the assignment, the emitted command — not
 * merely the presence of a token somewhere in the file.
 */

test('IPS-001: every failure path routes through the catchable helper', () => {
    const src = installer();
    assert.match(src, /function Stop-Install/);
    assert.match(src, /throw "CLI-JAW installation failed/);
    // ANY `exit` with an argument defeats `irm | iex` — including inline forms like
    // `if ($true) { exit 2 }`, parenthesized `exit (2)`, and `exit $code`, all of which
    // a numeric-literal pattern would miss. `exit /b` is batch inside a here-string
    // fixture, not PowerShell, so it is excluded only when it is not commented out.
    const offenders = src
        .split('\n')
        // Strip quoted strings BEFORE comments: a '#' inside a string would otherwise
        // truncate the line and hide a following `exit`, e.g. `$x = '#'; exit $code`.
        // Messages also legitimately read "(exit $code)", so strings must go first.
        .map(l => l.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''"))
        .map(l => l.replace(/#.*$/, ''))
        .filter(l => /(^|[;{]|\bthen\b)\s*exit\b/.test(l) && !/exit \/b/.test(l))
        .map(l => l.trim());
    assert.deepEqual(offenders, [], 'exit N kills the caller under irm | iex: ' + offenders.join(' | '));
});

test('IPS-002: the Node gate compares full versions, not the major component', () => {
    const src = installer();
    assert.match(src, /\[version\]'22\.4\.0'/);
    // The operative comparison — a `.Major -lt 22` check would accept 22.3.
    assert.match(src, /if \(\$nodeVersion -lt \$MinimumNodeVersion\)/);
    assert.doesNotMatch(src, /\$nodeVersion\.Major\s+-lt/, 'major-only comparison accepts 22.0-22.3');
    assert.equal(JSON.parse(read('package.json')).engines.node, '>=22.4.0');
});

test('IPS-003: npm is resolved once, as an Application, and never reassigned', () => {
    const src = installer();
    assert.match(src, /-CommandType Application/);
    assert.match(src, /\$npmPath = Resolve-CommandPath @\('npm\.cmd', 'npm\.exe', 'npm'\)/);
    // A later reassignment could reintroduce npm.ps1 while both strings above survive.
    const assignments = (src.match(/\$npmPath\s*=/g) ?? []).length;
    assert.equal(assignments, 1, 'npmPath must be assigned exactly once');
    // Only code matters — the file explains WHY npm.ps1 is avoided in a comment.
    const code = src.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
    assert.doesNotMatch(code, /npm\.ps1/, 'npm.ps1 must never be selected in code');
});

test('IPS-004: no native-command helper re-enables Stop around its invocation', () => {
    const src = installer();
    // The file-level default is Stop; each helper must relax it locally. A helper that
    // restores Stop makes harmless stderr fail the install on PowerShell 5.1.
    for (const helper of ['function Invoke-NativeCapture', 'function Invoke-NativeStreaming']) {
        const start = src.indexOf(helper);
        assert.ok(start > 0, `${helper} must exist`);
        const body = src.slice(start, src.indexOf('\n}', start));
        assert.match(body, /\$ErrorActionPreference = 'Continue'/, `${helper} must relax ErrorActionPreference`);
        assert.doesNotMatch(body, /\$ErrorActionPreference = 'Stop'/, `${helper} must not restore Stop around the call`);
        assert.match(body, /\$LASTEXITCODE/, `${helper} must keep the exit code authoritative`);
    }
});

test('IPS-005: the emitted PATH command never serializes the merged process PATH', () => {
    const src = installer();
    assert.match(src, /GetEnvironmentVariable\('Path', 'User'\)/);
    // Inspect the SetEnvironmentVariable call sites, so parentheses or concatenation
    // cannot smuggle $env:Path into the User target.
    for (const line of src.split('\n')) {
        if (!line.includes("SetEnvironmentVariable('Path'")) continue;
        assert.doesNotMatch(line, /\$env:Path/, `merged process PATH written to the User target: ${line.trim()}`);
    }
    // The criterion is "existing User PATH PLUS the missing npm prefix", so the append
    // matters as much as the absences. Dropping it survived every absence-only check.
    assert.match(src, /\+ '\$escapedGlobalBin'/, 'guidance must append the missing npm prefix');
    assert.match(src, /\$userPath -split/, 'guidance must preserve existing User PATH entries');
});

test('IPS-006: the follow-up command actually emitted is the .cmd shim', () => {
    const src = installer();
    // Match the emitted line, not a token that could survive in a comment.
    const nextLines = src.split('\n').filter(l => /Write-(Info|Ok|Warn2)\s+'Next:/.test(l));
    assert.ok(nextLines.length > 0, 'the installer must print a next-step command');
    for (const line of nextLines) {
        // Every command token in the line must be the .cmd shim, not just one of them.
        for (const token of line.match(/\bjaw(\.\w+)?\b/g) ?? []) {
            assert.equal(token, 'jaw.cmd', `next-step guidance must use jaw.cmd: ${line.trim()}`);
        }
    }
});

test('IPS-007: both PowerShell lanes actually invoke the contract test', () => {
    const wf = read('.github/workflows/postinstall-platform.yml');
    // Per shell, require a step whose run block references the contract script — a
    // `shell: powershell` step that merely exists proves nothing.
    const steps = wf.split(/\n      - name: /);
    for (const shell of ['pwsh', 'powershell']) {
        const matching = steps.filter(s =>
            new RegExp(`shell: ${shell}\\b`).test(s) && s.includes('install-ps1-contract.ps1'));
        assert.ok(matching.length > 0, `no ${shell} step runs install-ps1-contract.ps1`);
        for (const step of matching) {
            assert.doesNotMatch(step, /continue-on-error/, `the ${shell} contract step must be a gate`);
            assert.doesNotMatch(step, /if:\s*\$\{\{\s*false/, `the ${shell} contract step must not be disabled`);
        }
    }
});

test('IPS-008: the Windows contract executes the three previously-unrun scenarios', () => {
    // These acceptance paths cannot run on macOS, so this asserts the CI-side test
    // actually contains them. A reviewer found all three were only string checks:
    // the -File exit code was never observed, the PATH guidance branch was suppressed
    // by -Prefix in every fixture, and no test set a restrictive execution policy.
    const contract = read('tests/windows/install-ps1-contract.ps1');
    assert.match(contract, /-NoProfile -File \$installer/, 'must invoke the installer via -File');
    assert.match(contract, /\$childExit -ne 0/, 'must assert a nonzero child exit code');
    // Fail-closed: the shell must resolve and an exit code must exist, or the check is
    // skipped and an unlaunchable shell greens the test.
    assert.match(contract, /must be resolvable to launch the -File check/);
    assert.match(contract, /the -File child must report an exit code/);
    // The PATH branch must be EXECUTED without -Prefix, not inspected.
    assert.match(contract, /MACHINE-ONLY-SENTINEL/, 'PATH guidance must be checked against a machine-only sentinel');
    assert.match(contract, /guidance must not contain machine-only PATH entries/);
    // The criterion is "existing User PATH PLUS the missing npm prefix". Asserting only
    // absences let a mutation that drops the prefix append stay green.
    assert.match(contract, /guidance must add the missing npm prefix/);
    assert.match(contract, /guidance must preserve the existing User PATH entries/);
    assert.match(contract, /guidance must write the composed entries to the User target/);
    // PowerShell does not treat backslash as an interpolation escape, so a double-quoted
    // regex containing $entries expands at construction time and dies under Set-StrictMode.
    // Every regex naming a PowerShell variable must therefore be single-quoted.
    for (const line of contract.split('\n')) {
        if (!/-match "/.test(line)) continue;
        assert.doesNotMatch(line, /-match "[^"]*\$[A-Za-z_]/,
            `double-quoted regex interpolates a variable and fails under strict mode: ${line.trim()}`);
    }
    assert.match(contract, /Set-ExecutionPolicy -Scope Process -ExecutionPolicy Restricted/, 'must exercise a restrictive policy');
    assert.match(contract, /jaw-cmd-ran/, 'must prove jaw.cmd runs under that policy');
    assert.match(contract, /guidance must not serialize the merged process PATH/);
});
