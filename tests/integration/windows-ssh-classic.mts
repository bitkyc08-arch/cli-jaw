// #326 Windows OpenSSH/ConPTY regression gate.
// Runs on a Windows host (ssh localhost) or from any host against a Windows
// sshd via JAW_WINDOWS_SSH_HOST. Attribution evidence:

import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';

const HOST = process.env.JAW_WINDOWS_SSH_HOST || (process.platform === 'win32' ? 'localhost' : '');
const NOISE = [/\x1b\[\?9001[hl]/, /\x1b\[\?1004[hl]/, /\x1b\[\?1049[hl]/];

function sshRun(ttyFlags: string[], remoteCmd: string, stdinData?: string): Promise<{ out: Buffer; err: Buffer; code: number | null }> {
    return new Promise((resolve) => {
        const child = spawn('ssh', ['-o', 'BatchMode=yes', ...ttyFlags, HOST, remoteCmd], { stdio: ['pipe', 'pipe', 'pipe'] });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        child.stdout.on('data', (d) => out.push(d));
        child.stderr.on('data', (d) => err.push(d));
        const killer = setTimeout(() => child.kill('SIGKILL'), 30_000);
        child.on('close', (code) => {
            clearTimeout(killer);
            resolve({ out: Buffer.concat(out), err: Buffer.concat(err), code });
        });
        if (stdinData !== undefined) child.stdin.write(stdinData);
        child.stdin.end();
    });
}

const noiseProfile = (buf: Buffer) => NOISE.map((re) => re.test(buf.toString('latin1')));
const sameProfile = (a: boolean[], b: boolean[]) => a.length === b.length && a.every((v, i) => v === b[i]);

test('#326 windows ssh classic matrix', { skip: HOST ? false : 'requires Windows sshd (set JAW_WINDOWS_SSH_HOST or run on win32)' }, async () => {
    // control: host-side ConPTY noise profile without jaw
    const control = await sshRun(['-tt'], 'node -p "1+1"');
    assert.strictEqual(control.code, 0, 'control exit');
    const controlProfile = noiseProfile(control.out).map((v, i) => v || noiseProfile(control.err)[i]);

    // jaw over ssh -T: must be clean and exit 0
    const tCase = await sshRun(['-T'], 'jaw chat --simple --classic');
    assert.strictEqual(tCase.code, 0, 'ssh -T jaw exit: ' + tCase.err.toString('latin1').slice(0, 400));
    assert.ok(!noiseProfile(tCase.out).some(Boolean), 'ssh -T must not carry 9001/1004/1049');
    assert.ok(!noiseProfile(tCase.err).some(Boolean), 'ssh -T stderr clean');

    // jaw over ssh -tt: works, clean exit, noise profile equals host control
    const ttCase = await sshRun(['-tt'], 'jaw chat --simple --classic');
    assert.strictEqual(ttCase.code, 0, 'ssh -tt jaw exit');
    const ttProfile = noiseProfile(ttCase.out).map((v, i) => v || noiseProfile(ttCase.err)[i]);
    assert.ok(sameProfile(ttProfile, controlProfile), 'per-sequence noise profile must equal host-side control attribution');
    assert.ok(!ttProfile[2], '?1049 (alternate screen) must never appear from jaw');
});
