import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

function read(path: string): string {
    return readFileSync(join(ROOT, path), 'utf8');
}

test('root jaw CLI registers and routes the external JWC helper', () => {
    const cli = read('bin/cli-jaw.ts');

    assert.ok(cli.includes("'jwc'"), 'root known command list must include jwc');
    assert.ok(cli.includes("case 'jwc':"), 'root router must handle jaw jwc');
    assert.ok(cli.includes("await import('./commands/jwc.js')"), 'root router must import the jwc command module');
    assert.ok(cli.includes('jwc install|clean|doctor'), 'root help must advertise the jwc helper');
});

test('jaw jwc exposes install clean and doctor as external-only subcommands', () => {
    const command = read('bin/commands/jwc.ts');

    for (const token of [
        'jaw jwc install [--prefix <dir>] [--package <pkg>] [--dry-run] [--json]',
        'jaw jwc clean',
        'jaw jwc doctor',
        'cli-jaw does not bundle JWC',
        'DEFAULT_PACKAGE =',
        "'jawcode@latest'",
    ]) {
        assert.ok(command.includes(token), `jwc command must include ${token}`);
    }

    assert.ok(command.includes("const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'"), 'install must select npm.cmd on Windows');
    assert.ok(command.includes("'install', '--prefix', prefix, pkg"), 'install must use an explicit external npm prefix');
    assert.ok(command.includes("'--omit=dev', '--no-audit', '--no-fund'"), 'install must avoid dev deps, audit, and fund side effects');
    assert.ok(command.includes('execFileSync(npmBin, npmArgs'), 'install must use execFileSync without shell string composition');
    assert.equal(command.includes('shell: true'), false, 'jwc command must not use shell execution');
});

test('jaw jwc clean removes only the checked external prefix', () => {
    const command = read('bin/commands/jwc.ts');

    assert.ok(command.includes('function assertSafePrefix'), 'clean must share a safety guard');
    assert.ok(command.includes('prefix === root'), 'safety guard must reject filesystem root');
    assert.ok(command.includes('prefix === home'), 'safety guard must reject the user home');
    assert.ok(command.includes('prefix === jawHome'), 'safety guard must reject the JAW_HOME root');
    assert.ok(command.includes('rmSync(prefix, { recursive: true, force: true })'), 'clean must remove the external prefix recursively');
});

test('JWC guidance shows install doctor clean and cross-shell SDK setup', () => {
    const command = read('bin/commands/jwc.ts');
    const runtime = read('src/agent/jwc-runtime.ts');
    const handlers = read('src/cli/handlers.ts');

    for (const source of [command, runtime, handlers]) {
        assert.ok(source.includes('jaw jwc install'), 'guidance must mention jaw jwc install');
        assert.ok(source.includes('jaw jwc doctor'), 'guidance must mention jaw jwc doctor');
        assert.ok(source.includes('jaw jwc clean'), 'guidance must mention jaw jwc clean');
    }

    assert.ok(command.includes('export JWC_SDK_PATH='), 'POSIX export guidance must be printed');
    assert.ok(command.includes('$env:JWC_SDK_PATH='), 'PowerShell guidance must be printed');
    assert.ok(runtime.includes('does not bundle JWC'), 'runtime load failures must preserve no-bundled-JWC wording');
    assert.ok(runtime.includes('JWC_SDK_PATH=/absolute/path/to/jawcode/packages/jwc/dist-node/sdk.js'), 'runtime hint must preserve source-build override path');
    assert.ok(handlers.includes("nextCli === 'jwc'"), '/cli jwc must append the external runtime reminder');
});

test('docs advertise JWC as optional external runtime only', () => {
    const readme = read('README.md');
    const commands = read('structure/commands.md');
    const index = read('structure/INDEX.md');

    for (const source of [readme, commands, index]) {
        assert.ok(source.includes('jaw jwc install'), 'docs must mention jaw jwc install');
        assert.ok(source.includes('jaw jwc doctor'), 'docs must mention jaw jwc doctor');
        assert.ok(source.includes('jaw jwc clean'), 'docs must mention jaw jwc clean');
    }
    assert.ok(readme.includes('JWC is optional and external-only'), 'README must describe JWC as optional external-only');
});
