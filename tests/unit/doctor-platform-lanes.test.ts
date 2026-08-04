import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Source-shape assertions are deliberate here: doctor.ts and postinstall.ts
 * run checks against the live machine at import time, so behavioral testing of
 * their lanes would execute installer logic on the runner. The behavioral
 * proof lives in platform-kind.test.ts, which covers the functions these files
 * now call.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const doctor = fs.readFileSync(path.join(root, 'bin/commands/doctor.ts'), 'utf8');
const postinstall = fs.readFileSync(path.join(root, 'bin/postinstall.ts'), 'utf8');

function executableSource(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
}

// Every positive assertion runs against comment-stripped source. Matching raw
// source lets an assertion be satisfied by its own explanatory comment, which
// would keep the suite green after a revert of the very fix it guards.
const doctorCode = executableSource(doctor);
const postinstallCode = executableSource(postinstall);

/** The `if (isWindowsNative()) { ... } else if (isWSL()) { ... }` block. */
function platformBlock(): { windowsArm: string; wslArm: string; after: string } {
    const start = doctorCode.indexOf('if (isWindowsNative())');
    assert.notEqual(start, -1, 'doctor must gate the platform lanes on isWindowsNative()');

    const elseAt = doctorCode.indexOf('} else if (isWSL()) {', start);
    assert.notEqual(elseAt, -1, 'the WSL lane must be the else-arm of the windows-native check');

    // Walk braces from the `else if` to find where the whole block closes.
    const wslArmStart = doctorCode.indexOf('{', elseAt + '} else if (isWSL())'.length);
    let depth = 0;
    let end = -1;
    for (let i = wslArmStart; i < doctorCode.length; i++) {
        const ch = doctorCode[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) { end = i; break; }
        }
    }
    assert.notEqual(end, -1, 'the WSL arm must be balanced');

    return {
        windowsArm: doctorCode.slice(start, elseAt),
        wslArm: doctorCode.slice(elseAt, end + 1),
        after: doctorCode.slice(end + 1),
    };
}

test('the Windows-native lane contains only Windows checks', () => {
    const { windowsArm } = platformBlock();
    assert.match(windowsArm, /CLI tools \(Windows-native\)/);
    assert.match(windowsArm, /Windows \(native\)/);
    // The /mnt/ scan is meaningless on native Windows and must stay out.
    assert.doesNotMatch(windowsArm, /\/mnt\//);
    assert.doesNotMatch(windowsArm, /WSL sudo/);
});

test('the WSL lane keeps its own checks and the /mnt scan', () => {
    const { wslArm } = platformBlock();
    assert.match(wslArm, /CLI tools \(WSL-native\)/);
    assert.match(wslArm, /startsWith\('\/mnt\/'\)/);
    assert.match(wslArm, /WSL sudo/);
    assert.doesNotMatch(wslArm, /Windows-native/);
});

test('checks after the platform block stay unconditional', () => {
    const { after } = platformBlock();
    // Browser/headless diagnostics ran for every platform before the
    // restructure and must not have been captured into either arm.
    assert.match(after, /const headless/);
});

test('the Windows lane reports rejected candidates rather than re-checking accepted ones', () => {
    const { windowsArm } = platformBlock();
    assert.match(windowsArm, /detected\.rejected \?\? \[\]/);
    assert.match(windowsArm, /not launchable/);
    // Re-testing an already-accepted path would re-ask a settled question.
    assert.doesNotMatch(windowsArm, /isSpawnableCliFile/);
});

test('doctor --json exposes the resolved platform kind', () => {
    assert.match(doctorCode, /platform: resolvePlatformKind\(\)/);
});

test('postinstall no longer treats WSLENV or win32 as WSL evidence', () => {
    assert.doesNotMatch(postinstallCode, /WSLENV/);
    assert.doesNotMatch(postinstallCode, /looksLikeWsl/);
});

test('postinstall passes the npm invocation cwd, not the lifecycle cwd', () => {
    // npm runs lifecycle scripts from the package root, so process.cwd() here
    // makes the warning unreachable. Assert the EXACT call, on stripped source,
    // so reverting the argument fails this test.
    assert.match(
        postinstallCode,
        /isWindowsNodeLaunchedFromWsl\(\s*process\.platform\s*,\s*resolveInvocationCwd\(\)\s*\)/,
    );
    assert.doesNotMatch(
        postinstallCode,
        /isWindowsNodeLaunchedFromWsl\([^)]*process\.cwd\(\)/,
    );
});

test('both files import the canonical resolver', () => {
    for (const [name, source] of [['doctor.ts', doctorCode], ['postinstall.ts', postinstallCode]] as const) {
        assert.match(
            source,
            /from\s+'[^']*platform-kind\.js'/,
            `${name} must import the resolver`,
        );
    }
});
