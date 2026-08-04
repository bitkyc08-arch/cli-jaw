import test from 'node:test';
import assert from 'node:assert/strict';
import {
    resolvePlatformKind,
    isWindowsNative,
    isWsl,
    isWindowsNodeLaunchedFromWsl,
    resolveInvocationCwd,
    type PlatformKind,
    type PlatformProbes,
} from '../../src/core/platform-kind.js';

function probes(overrides: Partial<{
    files: Record<string, string>;
    paths: string[];
    release: string;
}> = {}): PlatformProbes {
    const files = overrides.files ?? {};
    const paths = new Set(overrides.paths ?? []);
    return {
        readText: (path) => files[path] ?? null,
        exists: (path) => paths.has(path),
        release: () => overrides.release ?? '',
    };
}

const CASES: Array<{
    name: string;
    platform: NodeJS.Platform;
    env: NodeJS.ProcessEnv;
    probes: PlatformProbes;
    expected: PlatformKind;
}> = [
    // The regression this module exists for.
    {
        name: 'win32 with WSLENV set stays windows-native',
        platform: 'win32',
        env: { WSLENV: 'GOPATH/p' },
        probes: probes(),
        expected: 'windows-native',
    },
    {
        name: 'win32 with every WSL env var set stays windows-native',
        platform: 'win32',
        env: { WSLENV: 'x', WSL_DISTRO_NAME: 'Ubuntu', WSL_INTEROP: '/run/WSL/1_interop' },
        probes: probes({ paths: ['/run/WSL'], release: 'microsoft-standard-WSL2' }),
        expected: 'windows-native',
    },
    // WSL positives, one per evidence class.
    {
        name: 'linux + WSL_DISTRO_NAME is wsl',
        platform: 'linux',
        env: { WSL_DISTRO_NAME: 'Ubuntu-24.04' },
        probes: probes(),
        expected: 'wsl',
    },
    {
        name: 'linux + WSL_INTEROP is wsl',
        platform: 'linux',
        env: { WSL_INTEROP: '/run/WSL/8_interop' },
        probes: probes(),
        expected: 'wsl',
    },
    {
        name: 'linux + /run/WSL marker is wsl even with a scrubbed env',
        platform: 'linux',
        env: {},
        probes: probes({ paths: ['/run/WSL'] }),
        expected: 'wsl',
    },
    {
        name: 'linux + WSLInterop binfmt is wsl (custom kernel case)',
        platform: 'linux',
        env: {},
        probes: probes({ paths: ['/proc/sys/fs/binfmt_misc/WSLInterop'] }),
        expected: 'wsl',
    },
    {
        name: 'linux + osrelease microsoft-standard-WSL2 is wsl',
        platform: 'linux',
        env: {},
        probes: probes({ files: { '/proc/sys/kernel/osrelease': '5.15.0-microsoft-standard-WSL2' } }),
        expected: 'wsl',
    },
    {
        name: 'linux + capitalised Microsoft in /proc/version is wsl (WSL1)',
        platform: 'linux',
        env: {},
        probes: probes({ files: { '/proc/version': 'Linux version 4.4.0-19041-Microsoft' } }),
        expected: 'wsl',
    },
    // Negatives.
    {
        name: 'plain linux is linux',
        platform: 'linux',
        env: {},
        probes: probes({ files: { '/proc/version': 'Linux version 6.8.0-generic' } }),
        expected: 'linux',
    },
    {
        name: 'linux + WSLENV alone is NOT wsl',
        platform: 'linux',
        env: { WSLENV: 'GOPATH/p' },
        probes: probes(),
        expected: 'linux',
    },
    { name: 'darwin', platform: 'darwin', env: {}, probes: probes(), expected: 'darwin' },
    { name: 'freebsd is other', platform: 'freebsd', env: {}, probes: probes(), expected: 'other' },
];

for (const testCase of CASES) {
    test(`resolvePlatformKind: ${testCase.name}`, () => {
        assert.equal(
            resolvePlatformKind(testCase.platform, testCase.env, testCase.probes),
            testCase.expected,
        );
    });
}

// Two INDEPENDENT predicates, so this is a real assertion rather than the
// tautology `kind === 'a' && kind === 'b'`.
test('isWindowsNative and isWsl never both hold', () => {
    for (const testCase of CASES) {
        const native = isWindowsNative(testCase.platform);
        const wsl = isWsl(testCase.platform, testCase.env, testCase.probes);
        assert.equal(native && wsl, false, `${testCase.name} must not be both`);
    }
});

test('empty kernel probe files fall through to os.release()', () => {
    const emptyProcProbes = probes({
        files: { '/proc/sys/kernel/osrelease': '   ', '/proc/version': '' },
        release: '5.15.0-microsoft-standard-WSL2',
    });
    assert.equal(resolvePlatformKind('linux', {}, emptyProcProbes), 'wsl');
});

test('isWindowsNodeLaunchedFromWsl keys on the UNC cwd, never on env', () => {
    assert.equal(isWindowsNodeLaunchedFromWsl('win32', '\\\\wsl$\\Ubuntu-24.04\\home\\j'), true);
    assert.equal(isWindowsNodeLaunchedFromWsl('win32', '\\\\wsl.localhost\\Ubuntu\\home\\j'), true);
    // Ordinary native Windows: no warning, regardless of interop env.
    assert.equal(isWindowsNodeLaunchedFromWsl('win32', 'C:\\Users\\j'), false);
    // A Linux process is never "Windows Node".
    assert.equal(isWindowsNodeLaunchedFromWsl('linux', '/home/j'), false);
    assert.equal(isWindowsNodeLaunchedFromWsl('win32', ''), false);
});

// The npm lifecycle boundary: a postinstall script's own cwd is the package
// root, so only INIT_CWD carries the user's directory.
test('resolveInvocationCwd prefers INIT_CWD inside an npm lifecycle script', () => {
    assert.equal(
        resolveInvocationCwd({ INIT_CWD: '\\\\wsl$\\Ubuntu\\home\\j\\project' }),
        '\\\\wsl$\\Ubuntu\\home\\j\\project',
    );
    assert.equal(resolveInvocationCwd({ INIT_CWD: '   ' }), process.cwd());
    assert.equal(resolveInvocationCwd({}), process.cwd());
});

test('the warning fires for an npm install started from a WSL directory', () => {
    assert.equal(
        isWindowsNodeLaunchedFromWsl('win32', resolveInvocationCwd({ INIT_CWD: '\\\\wsl$\\Ubuntu-24.04\\home\\j\\app' })),
        true,
    );
    // Same machine, install started from a Windows directory: no warning.
    assert.equal(
        isWindowsNodeLaunchedFromWsl('win32', resolveInvocationCwd({ INIT_CWD: 'C:\\src\\app' })),
        false,
    );
});
