import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { openServeLog } from '../../src/core/serve-log.ts';

function sink(): PassThrough {
    const stream = new PassThrough();
    stream.resume();
    return stream;
}

test('serve log appends across a simulated server restart', async () => {
    const home = await mkdtemp(join(tmpdir(), 'jaw-serve-log-'));
    try {
        const firstStdout = sink();
        const runOne = openServeLog(home, {}, firstStdout, sink());
        firstStdout.write('first run\n');
        await runOne.close();

        const secondStdout = sink();
        const runTwo = openServeLog(home, {}, secondStdout, sink());
        secondStdout.write('second run\n');
        await runTwo.close();

        assert.equal(runTwo.logPath, runOne.logPath);
        assert.equal(await readFile(runTwo.logPath, 'utf8'), 'first run\nsecond run\n');
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('serve log rotates once when the existing file reaches the cap', async () => {
    const home = await mkdtemp(join(tmpdir(), 'jaw-serve-log-rotate-'));
    const logPath = join(home, 'logs', 'serve.log');
    try {
        const initial = openServeLog(home, { maxBytes: 8 }, sink(), sink());
        await initial.close();
        await writeFile(logPath, '12345678');

        const stdout = sink();
        const rotated = openServeLog(home, { maxBytes: 8 }, stdout, sink());
        stdout.write('new\n');
        await rotated.close();

        assert.equal(await readFile(`${logPath}.1`, 'utf8'), '12345678');
        assert.equal(await readFile(logPath, 'utf8'), 'new\n');
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});
