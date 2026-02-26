import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const projectRoot = join(process.cwd());
const tsxBin = join(projectRoot, 'node_modules', '.bin', 'tsx');
const cliEntry = join(projectRoot, 'bin', 'cli-jaw.ts');

function isServerAlive(port: number) {
    return fetch(`http://127.0.0.1:${port}/api/session`, { signal: AbortSignal.timeout(1000) })
        .then(r => r.ok)
        .catch(() => false);
}

async function waitForServer(port: number, timeoutMs = 20000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (await isServerAlive(port)) return;
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error(`server did not become ready on port ${port}`);
}

async function findFreePort() {
    const net = await import('node:net');
    return await new Promise<number>((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            srv.close(() => resolve(port));
        });
    });
}

async function stopServer(child: import('node:child_process').ChildProcess) {
    if (child.killed || child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL');
            resolve();
        }, 2500);
        child.once('exit', () => {
            clearTimeout(timer);
            resolve();
        });
    });
}

test('MI-001: doctor --json reflects custom --home path', () => {
    if (!existsSync(tsxBin)) {
        test.skip('tsx binary not found; skipping integration test');
        return;
    }

    const customHome = mkdtempSync(join(tmpdir(), 'jaw-mi-doctor-'));
    try {
        const out = execFileSync(tsxBin, [cliEntry, '--home', customHome, 'doctor', '--json'], {
            cwd: projectRoot,
            encoding: 'utf8',
            timeout: 20000,
            env: { ...process.env, NO_COLOR: '1' },
        });
        const payload = JSON.parse(out);
        assert.ok(Array.isArray(payload.checks), 'doctor output should contain checks array');
        const homeCheck = payload.checks.find((c: Record<string, any>) => c.name === 'Home directory');
        assert.ok(homeCheck, 'doctor output should include Home directory check');
        assert.equal(homeCheck.detail, customHome);
    } finally {
        rmSync(customHome, { recursive: true, force: true });
    }
});

test('MI-002: two serve instances run independently on different homes/ports', async () => {
    if (!existsSync(tsxBin)) {
        test.skip('tsx binary not found; skipping integration test');
        return;
    }

    const homeA = mkdtempSync(join(tmpdir(), 'jaw-mi-a-'));
    const homeB = mkdtempSync(join(tmpdir(), 'jaw-mi-b-'));
    const portA = await findFreePort();
    const portB = await findFreePort();

    const procA = spawn(tsxBin, [cliEntry, '--home', homeA, 'serve', '--port', String(portA), '--no-open'], {
        cwd: projectRoot,
        stdio: 'ignore',
        env: { ...process.env, NO_COLOR: '1' },
    });
    const procB = spawn(tsxBin, [cliEntry, '--home', homeB, 'serve', '--port', String(portB), '--no-open'], {
        cwd: projectRoot,
        stdio: 'ignore',
        env: { ...process.env, NO_COLOR: '1' },
    });

    try {
        await Promise.all([waitForServer(portA), waitForServer(portB)]);

        const [resA, resB] = await Promise.all([
            fetch(`http://127.0.0.1:${portA}/api/session`, { signal: AbortSignal.timeout(2000) }),
            fetch(`http://127.0.0.1:${portB}/api/session`, { signal: AbortSignal.timeout(2000) }),
        ]);

        assert.equal(resA.status, 200);
        assert.equal(resB.status, 200);

        const [jsonA, jsonB] = await Promise.all([resA.json(), resB.json()]);
        assert.ok(jsonA && typeof jsonA === 'object');
        assert.ok(jsonB && typeof jsonB === 'object');
    } finally {
        await Promise.all([stopServer(procA), stopServer(procB)]);
        rmSync(homeA, { recursive: true, force: true });
        rmSync(homeB, { recursive: true, force: true });
    }
});
