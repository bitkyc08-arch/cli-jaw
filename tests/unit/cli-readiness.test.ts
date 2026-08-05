import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { getCliReadiness, pickFirstReadyCli } from '../../src/cli/readiness.ts';
import { CLI_KEYS } from '../../src/cli/registry.ts';

function dependencies(options: {
    ready?: string[];
    capabilityOk?: boolean;
    codexToken?: string | null;
}) {
    const ready = new Set(options.ready ?? []);
    return {
        detectAllCli: () => Object.fromEntries(CLI_KEYS.map(cli => [cli, {
            available: ready.has(cli),
            path: ready.has(cli) ? `/fake/${cli}` : null,
        }])),
        readClaudeCreds: () => null,
        readCodexTokens: () => options.codexToken ? { access_token: options.codexToken } : null,
        hasCopilotAuthSync: () => false,
        probeCodexAppCapability: () => options.capabilityOk === false
            ? { ok: false, exitCode: 2, signal: null, timedOut: false, outputLimitExceeded: false, reason: 'exit-nonzero' as const }
            : { ok: true, exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false, reason: 'ready' as const },
    };
}

test('codex-app wins when codex-app and pi are both ready', () => {
    const picked = pickFirstReadyCli(undefined, dependencies({
        ready: ['codex-app', 'pi'],
        codexToken: 'token',
    }));
    assert.equal(picked, 'codex-app');
});

test('failed app-server capability falls through to the next ready runtime', () => {
    const deps = dependencies({ ready: ['codex-app', 'pi'], capabilityOk: false, codexToken: 'token' });
    const codexApp = getCliReadiness(deps).find(row => row.cli === 'codex-app');
    assert.deepEqual(codexApp, {
        cli: 'codex-app',
        installed: false,
        binaryInstalled: true,
        capabilityReady: false,
        authenticated: true,
        source: 'app-server unavailable: exit-nonzero; auth: auth.json',
    });
    assert.equal(pickFirstReadyCli(undefined, deps), 'pi');
});

test('missing Codex token leaves capability-ready codex-app in installed-only tier', () => {
    const codexApp = getCliReadiness(dependencies({ ready: ['codex-app'], codexToken: null }))
        .find(row => row.cli === 'codex-app');
    assert.equal(codexApp?.binaryInstalled, true);
    assert.equal(codexApp?.capabilityReady, true);
    assert.equal(codexApp?.installed, true);
    assert.equal(codexApp?.authenticated, false);
    assert.equal(pickFirstReadyCli(undefined, dependencies({ ready: ['codex-app'], codexToken: null })), 'codex-app');
});

test('valid env override is preserved and invalid override falls back to codex-app', () => {
    const script = "import('./src/cli/registry.ts').then(({DEFAULT_CLI}) => process.stdout.write(DEFAULT_CLI))";
    const run = (value: string) => spawnSync(process.execPath, [
        '--import', 'tsx', '--input-type=module', '--eval', script,
    ], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, CLI_JAW_DEFAULT_CLI: value },
    });
    const valid = run('claude');
    const invalid = run('definitely-not-a-cli');
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(valid.stdout, 'claude');
    assert.equal(invalid.status, 0, invalid.stderr);
    assert.equal(invalid.stdout, 'codex-app');
});

test('CLI_JAW_DEFAULT_CLI is prepended to picker priority', () => {
    const script = `
        import('./src/cli/readiness.ts').then(({ pickFirstReadyCli }) => {
            const ready = { available: true, path: '/fake/binary' };
            const picked = pickFirstReadyCli(undefined, {
                detectAllCli: () => ({ claude: ready, 'codex-app': ready, pi: ready }),
                readClaudeCreds: () => ({ token: 'claude-token', source: 'fixture' }),
                readCodexTokens: () => ({ access_token: 'codex-token' }),
                hasCopilotAuthSync: () => false,
                probeCodexAppCapability: () => ({ ok: true, exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false, reason: 'ready' }),
            });
            process.stdout.write(picked);
        });
    `;
    const result = spawnSync(process.execPath, [
        '--import', 'tsx', '--input-type=module', '--eval', script,
    ], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, CLI_JAW_DEFAULT_CLI: 'claude' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'claude');
});

test('custom default order contains no duplicate codex-app entry', () => {
    let probeCalls = 0;
    const deps = dependencies({ ready: ['codex-app'], codexToken: 'token' });
    const wrapped = {
        ...deps,
        probeCodexAppCapability: (binary: string) => {
            probeCalls += 1;
            return deps.probeCodexAppCapability(binary);
        },
    };
    assert.equal(pickFirstReadyCli(['pi', 'codex-app', 'codex-app'], wrapped), 'codex-app');
    assert.equal(probeCalls, 1);
});
