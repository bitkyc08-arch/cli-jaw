/**
 * #479 regression: `ssh host 'jaw serve ...'` failed with
 * "nohup: failed to run command 'jaw'" because ~/.local/bin is added to PATH
 * only by files a non-interactive shell never reads. doctor had no check for
 * it, and could not have had a naive one: doctor runs in the interactive
 * shell where PATH already works.
 *
 * The probes are injected, so the whole matrix runs without an SSH host.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    checkNonInteractivePath,
    candidateInstallDirs,
    nonInteractivePathRemedy,
    type NonInteractivePathProbes,
} from '../../src/core/noninteractive-path.ts';

const HOME = '/home/box';
const POSIX_BASELINE = '/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games';

/** Probes where exactly `present` resolve as executables. */
function probes(baseline: string | null, present: string[]): NonInteractivePathProbes {
    return {
        baselinePath: () => baseline,
        isExecutableFile: (path) => present.includes(path),
    };
}

test('NIP-001: the #479 shape is reported unreachable, not missing', () => {
    // Exactly the reporter's host: installed in ~/.local/bin, which the
    // non-interactive baseline PATH does not contain.
    const result = checkNonInteractivePath('jaw', HOME, probes(POSIX_BASELINE, [join(HOME, '.local/bin/jaw')]));
    assert.equal(result.status, 'unreachable');
    assert.equal(result.foundIn, join(HOME, '.local/bin'));
});

test('NIP-002: a binary on the baseline PATH is reachable', () => {
    const result = checkNonInteractivePath('jaw', HOME, probes(POSIX_BASELINE, ['/usr/local/bin/jaw']));
    assert.equal(result.status, 'reachable');
    assert.equal(result.foundIn, '/usr/local/bin');
});

test('NIP-003: a binary installed nowhere is not-installed, so no PATH advice is given', () => {
    // Distinct from unreachable: telling this user to fix PATH would be wrong.
    const result = checkNonInteractivePath('jaw', HOME, probes(POSIX_BASELINE, []));
    assert.equal(result.status, 'not-installed');
    assert.equal(result.foundIn, null);
});

test('NIP-004: no baseline PATH yields unknown rather than a false alarm', () => {
    const result = checkNonInteractivePath('jaw', HOME, probes(null, [join(HOME, '.local/bin/jaw')]));
    assert.equal(result.status, 'unknown');
});

test('NIP-005: the check ignores the caller PATH entirely', () => {
    // The bug is invisible from an interactive shell; a check that consulted
    // process.env.PATH would report reachable on the reporter's host.
    const original = process.env['PATH'];
    process.env['PATH'] = `${join(HOME, '.local/bin')}:${POSIX_BASELINE}`;
    try {
        const result = checkNonInteractivePath('jaw', HOME, probes(POSIX_BASELINE, [join(HOME, '.local/bin/jaw')]));
        assert.equal(result.status, 'unreachable');
    } finally {
        if (original === undefined) delete process.env['PATH']; else process.env['PATH'] = original;
    }
});

test('NIP-006: a candidate dir already on the baseline is not double-reported', () => {
    const baseline = `${join(HOME, '.local/bin')}:${POSIX_BASELINE}`;
    const result = checkNonInteractivePath('jaw', HOME, probes(baseline, [join(HOME, '.local/bin/jaw')]));
    assert.equal(result.status, 'reachable');
});

test('NIP-007: candidate dirs cover the installer default', () => {
    // scripts/install.sh configures ~/.local/bin; if that moves, this check
    // stops seeing the very case #479 reported.
    assert.ok(candidateInstallDirs(HOME).includes(join(HOME, '.local', 'bin')));
});

test('NIP-010: a version-managed prefix is found via caller-supplied dirs', () => {
    // Observed on the dev host: nvm puts jaw in a version-specific prefix that
    // no static list can enumerate. Without this, the check reports
    // "not-installed" and stays silent on a host that IS broken over ssh.
    const nvmBin = join(HOME, '.nvm/versions/node/v22.19.0/bin');
    const result = checkNonInteractivePath(
        'jaw', HOME, probes(POSIX_BASELINE, [join(nvmBin, 'jaw')]), [nvmBin],
    );
    assert.equal(result.status, 'unreachable');
    assert.equal(result.foundIn, nvmBin);
});

test('NIP-011: caller-supplied dirs are searched before the static list', () => {
    const nvmBin = join(HOME, '.nvm/versions/node/v22.19.0/bin');
    assert.equal(candidateInstallDirs(HOME, [nvmBin])[0], nvmBin);
});

test('NIP-008: the remedy is runnable in a non-interactive shell', () => {
    const lines = nonInteractivePathRemedy('jaw', join(HOME, '.local/bin'));
    const text = lines.join('\n');
    assert.match(text, /\/home\/box\/\.local\/bin\/jaw/, 'must offer the absolute path');
    assert.match(text, /\.zshenv/, 'zsh needs the one file a non-interactive shell reads');
    // tmux/screen cannot be driven from a one-shot ssh command.
    assert.doesNotMatch(text, /tmux|screen/, 'interactive multiplexers are not a remote-one-shot remedy');
});

test('NIP-009: doctor wires the check in and skips it on win32', () => {
    const src = readFileSync(new URL('../../bin/commands/doctor.ts', import.meta.url), 'utf8');
    assert.match(src, /checkNonInteractivePath/, 'doctor must run the check');
    assert.match(src, /getconf/, 'the baseline must come from getconf PATH, not process.env');
    const guard = src.indexOf("process.platform !== 'win32'");
    const call = src.indexOf('checkNonInteractivePath(');
    assert.ok(guard !== -1 && guard < call, 'the POSIX guard must precede the check');
});
