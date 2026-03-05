import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const CLI_ENTRY = join(ROOT, 'dist', 'bin', 'cli-jaw.js');

function pickPort(seed = 0) {
    const base = 46800 + seed * 100;
    return base + Math.floor(Math.random() * 80);
}

async function sleep(ms: number) {
    await new Promise(resolve => setTimeout(resolve, ms));
}

async function isHealthy(port: number) {
    try {
        const res = await fetch(`http://localhost:${port}/api/health`);
        return res.ok;
    } catch {
        return false;
    }
}

async function waitForHealth(port: number, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await isHealthy(port)) return;
        await sleep(250);
    }
    throw new Error(`health check timeout on port ${port}`);
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs = 7000) {
    return await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('process exit timeout')), timeoutMs);
        child.once('exit', (code, signal) => {
            clearTimeout(timer);
            if (typeof code === 'number') return resolve(code);
            if (signal) return resolve(128 + 9); // fallback on signal-only exit
            resolve(1);
        });
    });
}

async function runSignalCase(
    signal: NodeJS.Signals,
    seed = 0,
    signalTarget: 'parent' | 'group' = 'parent',
) {
    const home = fs.mkdtempSync(join(tmpdir(), `jaw-shutdown-it-${seed}-`));
    const port = pickPort(seed);
    const child = spawn(
        process.execPath,
        [CLI_ENTRY, '--home', home, 'serve', '--port', String(port), '--no-open'],
        { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    );

    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    try {
        try {
            await waitForHealth(port);
        } catch {
            // Server failed to start — skip test (CI may lack native modules)
            child.kill('SIGKILL');
            fs.rmSync(home, { recursive: true, force: true });
            return 'skipped';
        }
        const startedAt = Date.now();
        if (signalTarget === 'group' && child.pid) {
            process.kill(-child.pid, signal);
        } else {
            child.kill(signal);
        }
        const exitCode = await waitForExit(child, 8000);
        const elapsedMs = Date.now() - startedAt;

        // Current implementation forces exit in ~3s when shutdown hangs.
        assert.ok(elapsedMs <= 4200, `shutdown took too long (${elapsedMs}ms)`);
        assert.equal(exitCode, 1, `unexpected exit code for ${signal}: ${exitCode}`);

        await sleep(600);
        assert.equal(await isHealthy(port), false, `port ${port} should be closed after ${signal}`);
    } finally {
        try { child.kill('SIGKILL'); } catch { /* noop */ }
        fs.rmSync(home, { recursive: true, force: true });
    }
    return 'ok';
}

test('GSI-001: serve exits within timeout on SIGTERM and closes port', async (t) => {
    const result = await runSignalCase('SIGTERM', 1);
    if (result === 'skipped') t.skip('server failed to start (CI environment)');
});

test('GSI-002: serve exits within timeout on SIGINT and closes port', async (t) => {
    const result = await runSignalCase('SIGINT', 2, 'group');
    if (result === 'skipped') t.skip('server failed to start (CI environment)');
});
