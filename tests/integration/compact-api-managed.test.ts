import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

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

test('CMP-SMOKE-001: managed /compact succeeds on isolated server with seeded history', { timeout: 20000 }, async () => {
    if (!existsSync(tsxBin)) {
        test.skip('tsx binary not found; skipping compact smoke test');
        return;
    }

    const home = mkdtempSync(join(tmpdir(), 'jaw-compact-smoke-'));
    const port = await findFreePort();
    const proc = spawn(tsxBin, [cliEntry, '--home', home, 'serve', '--port', String(port), '--no-open'], {
        cwd: projectRoot,
        stdio: 'ignore',
        env: { ...process.env, NO_COLOR: '1' },
    });

    try {
        await waitForServer(port);

        const settingsRes = await fetch(`http://127.0.0.1:${port}/api/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cli: 'codex' }),
            signal: AbortSignal.timeout(3000),
        });
        assert.equal(settingsRes.status, 200);

        const dbPath = join(home, 'jaw.db');
        const db = new Database(dbPath);
        db.prepare('DELETE FROM messages').run();
        db.prepare('DELETE FROM session WHERE id != ?').run('default');
        db.prepare('UPDATE session SET active_cli=?, session_id=NULL, model=?, permissions=?, working_dir=?, effort=? WHERE id=?')
            .run('codex', 'gpt-5.4', 'auto', home, 'medium', 'default');
        const insert = db.prepare('INSERT INTO messages (role, content, cli, model, trace, working_dir) VALUES (?, ?, ?, ?, NULL, ?)');
        insert.run('user', 'Preserve the deployment status.', 'codex', 'gpt-5.4', home);
        insert.run('assistant', 'Deployment is blocked on migration rollback validation.', 'codex', 'gpt-5.4', home);
        db.close();

        const res = await fetch(`http://127.0.0.1:${port}/api/command`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: '/compact keep deployment status only' }),
            signal: AbortSignal.timeout(5000),
        });
        assert.equal(res.status, 200);

        const payload = await res.json();
        assert.equal(payload.ok, true);
        assert.equal(payload.code, 'compact_done');
        assert.equal(payload.meta?.path, 'managed');

        const verifyDb = new Database(dbPath, { readonly: true });
        const latest = verifyDb.prepare('SELECT role, content, trace FROM messages ORDER BY id DESC LIMIT 1').get() as Record<string, string> | undefined;
        assert.ok(latest, 'expected managed compact marker row to be written');
        assert.equal(latest?.role, 'assistant');
        assert.equal(latest?.content, 'Conversation compacted.');
        assert.match(String(latest?.trace || ''), /^\[assistant\] Managed compact summary:/);

        const session = verifyDb.prepare('SELECT session_id, active_cli FROM session WHERE id = ?').get('default') as Record<string, string | null> | undefined;
        assert.equal(session?.session_id, null, 'managed compact should clear persisted session id');
        assert.equal(session?.active_cli, 'codex');
        verifyDb.close();
    } finally {
        await stopServer(proc);
        rmSync(home, { recursive: true, force: true });
    }
});
