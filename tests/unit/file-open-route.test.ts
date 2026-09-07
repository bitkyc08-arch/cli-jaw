import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

test('Linux file-open dispatch does not wait for a desktop application', {
    skip: process.platform === 'win32' ? 'POSIX executable fixture; Linux/macOS exercise the Linux route' : false,
    timeout: 30_000,
}, async t => {
    const root = mkdtempSync(join(tmpdir(), 'jaw-file-open-'));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const sockets = new Set<Socket>();
    const control = createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    control.listen(0, '127.0.0.1');
    await once(control, 'listening');
    const address = control.address();
    assert.ok(address && typeof address !== 'string');
    const opener = join(bin, 'xdg-open');
    writeFileSync(opener, `#!${process.execPath}
const net = require('node:net');
const fs = require('node:fs');
const socket = net.connect(${address.port}, '127.0.0.1', () => {
    socket.write(JSON.stringify({ pid: process.pid, args: process.argv.slice(2),
        ignoredStdio: [0, 1, 2].every(fd => fs.fstatSync(fd).isCharacterDevice()) }) + '\\n');
});
socket.on('data', () => { socket.end(); });
socket.on('error', () => { process.exitCode = 1; });
socket.on('end', () => { socket.end(); });
`, { mode: 0o755 });
    const fixture = fileURLToPath(new URL('../fixtures/file-open-server.ts', import.meta.url));
    const server = fork(fixture, [], {
        execArgv: ['--import', 'tsx'],
        env: { ...process.env, CLI_JAW_HOME: join(root, 'home'), NODE_ENV: 'test', FILE_OPEN_TEST_BIN: bin },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let output = '';
    server.stdout!.on('data', chunk => { output += String(chunk); });
    server.stderr!.on('data', chunk => { output += String(chunk); });
    const closed = once(server, 'exit');
    try {
        const [ready] = await once(server, 'message', { signal: AbortSignal.timeout(10_000) });
        assert.ok(ready && typeof ready === 'object' && 'port' in ready, output);
        const base = `http://127.0.0.1:${ready.port}`;
        const post = (body: unknown, authenticated = true) => fetch(`${base}/api/file/open`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-test-auth': authenticated ? 'allow' : '' },
            body: JSON.stringify(body), signal: AbortSignal.timeout(3_000),
        });
        const document = join(root, 'report ; $safe.md');
        const binary = join(root, 'archive.bin');
        writeFileSync(document, 'fixture');
        writeFileSync(binary, 'fixture');
        const colonName = join(root, 'literal.md:12');
        writeFileSync(colonName, 'exact filename wins over line suffix');
        for (const [input, opened, resolvedTarget, strategy] of [
            [document + ':12:3', document, document, 'reveal'],
            [binary, root, binary, 'folder'],
            [root, root, root, 'directory'],
            [colonName, root, colonName, 'folder'],
        ] as const) {
            await t.test(`responsive while ${strategy} opener is alive`, async () => {
                const connection = once(control, 'connection', { signal: AbortSignal.timeout(3_000) });
                // Catch immediately: a regressed synchronous server times out while
                // the parent is independently probing its event loop.
                const response = post({ path: input }).then(value => ({ value }), error => ({ error }));
                const [socket] = await connection as [Socket];
                try {
                    const data = await new Promise<string>((resolve, reject) => {
                        let buffer = '';
                        const timer = setTimeout(() => finish(new Error('opener handshake timed out')), 3_000);
                        const onClose = () => finish(new Error('opener closed before handshake'));
                        const onError = (error: Error) => finish(error);
                        const onData = (chunk: Buffer) => {
                            buffer += chunk.toString();
                            if (buffer.includes('\n')) finish();
                        };
                        function finish(error?: Error) {
                            clearTimeout(timer);
                            socket.off('data', onData);
                            socket.off('close', onClose);
                            socket.off('error', onError);
                            if (error) reject(error);
                            else resolve(buffer.slice(0, buffer.indexOf('\n')));
                        }
                        socket.on('data', onData);
                        socket.once('close', onClose);
                        socket.once('error', onError);
                    });
                    const launch = JSON.parse(data) as { pid: number; args: string[]; ignoredStdio: boolean };
                    process.kill(launch.pid, 0);
                    const probe = await fetch(`${base}/probe`, { signal: AbortSignal.timeout(3_000) });
                    assert.deepEqual(await probe.json(), { alive: true });
                    const result = await response;
                    if ('error' in result) throw result.error;
                    assert.equal(result.value.status, 200);
                    assert.deepEqual(await result.value.json(), {
                        ok: true, data: { opened: resolve(opened), resolvedTarget: resolve(resolvedTarget), strategy },
                    });
                    assert.deepEqual(launch.args, [resolve(opened)]);
                    assert.equal(launch.ignoredStdio, true, 'opener must not inherit server pipes');
                    process.kill(launch.pid, 0);
                } finally {
                    try {
                        if (!socket.destroyed) {
                            const ended = once(socket, 'close', { signal: AbortSignal.timeout(3_000) });
                            socket.end('stop');
                            await ended;
                        }
                    } finally {
                        socket.destroy();
                        await response;
                    }
                }
            });
        }
        await t.test('successful dispatch does not claim application exit success', async () => {
            writeFileSync(opener, `#!${process.execPath}\nprocess.exitCode = 7;\n`, { mode: 0o755 });
            const response = await post({ path: document });
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), {
                ok: true, data: { opened: document, resolvedTarget: document, strategy: 'reveal' },
            });
        });
        await t.test('launch errors and rejected paths preserve HTTP outcomes', async () => {
            renameSync(opener, opener + '.hidden');
            const missing = await post({ path: document });
            assert.equal(missing.status, 500);
            assert.deepEqual(await missing.json(), { ok: false, error: 'open_failed' });
            renameSync(opener + '.hidden', opener);
            chmodSync(opener, 0o600);
            const denied = await post({ path: document });
            assert.equal(denied.status, 500);
            assert.deepEqual(await denied.json(), { ok: false, error: 'open_failed' });
            for (const [body, status, error] of [
                [{ path: '' }, 400, 'path_required'],
                [{ path: 42 }, 400, 'path_required'],
                [{ path: join(root, 'missing.md') }, 404, 'file_not_found'],
            ] as const) {
                const response = await post(body);
                assert.equal(response.status, status);
                assert.deepEqual(await response.json(), { ok: false, error });
            }
            assert.equal((await post({ path: document }, false)).status, 401);
            assert.equal((await fetch(`${base}/probe`, { signal: AbortSignal.timeout(3_000) })).status, 200);
        });
    } finally {
        for (const socket of sockets) socket.destroy();
        if (server.connected) server.send('stop');
        const killTimer = setTimeout(() => server.kill('SIGKILL'), 2_000);
        const [code, signal] = await closed;
        clearTimeout(killTimer);
        await new Promise<void>(resolve => control.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
        assert.equal(signal, null, output);
        assert.equal(code, 0, output);
    }
});
