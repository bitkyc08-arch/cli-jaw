import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { buildRipgrepArgs, resolveRipgrepCommand, searchNotes } from '../../src/manager/notes/search.js';

type FakeSpawnOptions = {
    stdout?: string[];
    stderr?: string[];
    code?: number;
    errorCode?: string;
    onKill?: () => void;
};

function tmpRoot(): string {
    return mkdtempSync(join(tmpdir(), 'jaw-notes-search-test-'));
}

function match(path: string, line: string, lineNumber = 1): string {
    return JSON.stringify({
        type: 'match',
        data: {
            path: { text: path },
            line_number: lineNumber,
            lines: { text: `${line}\n` },
        },
    });
}

function fakeSpawn(options: FakeSpawnOptions): typeof spawn {
    return ((_command, _args, _options) => {
        const child = new EventEmitter() as EventEmitter & {
            stdout: PassThrough;
            stderr: PassThrough;
            kill: () => boolean;
        };
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => {
            options.onKill?.();
            queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
            return true;
        };
        queueMicrotask(() => {
            if (options.errorCode) {
                const error = Object.assign(new Error(options.errorCode), { code: options.errorCode });
                child.emit('error', error);
                return;
            }
            for (const line of options.stdout || []) child.stdout.write(`${line}\n`);
            for (const line of options.stderr || []) child.stderr.write(`${line}\n`);
            child.emit('close', options.code ?? 0);
        });
        return child as unknown as ReturnType<typeof spawn>;
    }) as typeof spawn;
}

test('notes search can use a resolved ripgrep binary outside the server PATH', async () => {
    let command = '';
    const spawnImpl = ((cmd, _args, _options) => {
        command = String(cmd);
        return fakeSpawn({ code: 1 })(cmd, _args, _options);
    }) as typeof spawn;

    const results = await searchNotes(tmpRoot(), 'alpha', {
        ripgrepPath: '/opt/codex/vendor/path/rg',
        spawnImpl,
    });

    assert.deepEqual(results, []);
    assert.equal(command, '/opt/codex/vendor/path/rg');
});

test('notes search honors CLI_JAW_RIPGREP_PATH for manager service environments', () => {
    const previous = process.env.CLI_JAW_RIPGREP_PATH;
    try {
        process.env.CLI_JAW_RIPGREP_PATH = '/custom/bin/rg';
        assert.equal(resolveRipgrepCommand(), '/custom/bin/rg');
    } finally {
        if (previous === undefined) delete process.env.CLI_JAW_RIPGREP_PATH;
        else process.env.CLI_JAW_RIPGREP_PATH = previous;
    }
});

test('notes search builds rg args for literal dash-leading queries', () => {
    const args = buildRipgrepArgs('--help', '/notes', false);

    assert.ok(args.includes('--no-config'));
    assert.ok(args.includes('--fixed-strings'));
    assert.ok(args.includes('--hidden'));
    assert.ok(args.includes('--no-ignore'));
    assert.equal(args[args.indexOf('--regexp') + 1], '--help');
    assert.equal(args.at(-1), '/notes');
});

test('notes search excludes protected backup and trash directories in rg and path walk', async () => {
    const args = buildRipgrepArgs('alpha', '/notes', false);
    const globPairs = args
        .map((arg, index) => arg === '--glob' ? args[index + 1] : null)
        .filter((arg): arg is string => Boolean(arg));
    assert.ok(globPairs.includes('!**/Backups.backupdb/**'));
    assert.ok(globPairs.includes('!**/.Trash/**'));
    assert.ok(globPairs.includes('!**/backup/**'));

    const root = tmpRoot();
    try {
        mkdirSync(join(root, 'backup'), { recursive: true });
        mkdirSync(join(root, '.Trash'), { recursive: true });
        writeFileSync(join(root, 'backup', 'alpha-plan.md'), 'alpha backup path\n');
        writeFileSync(join(root, '.Trash', 'alpha-trash.md'), 'alpha trash path\n');
        writeFileSync(join(root, 'alpha-live.md'), 'alpha live path\n');

        const results = await searchNotes(root, 'alpha', {
            spawnImpl: fakeSpawn({
                stdout: [
                    match(join(root, 'Backups.backupdb', 'hidden.md'), 'alpha hidden'),
                    match(join(root, '.Trash', 'hidden.md'), 'alpha trash'),
                    match(join(root, 'alpha-live.md'), 'alpha live'),
                ],
            }),
        });

        assert.deepEqual(results.map(result => result.path), ['alpha-live.md']);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('notes search parses matches and filters reserved folders', async () => {
    const root = tmpRoot();
    try {
        const results = await searchNotes(root, 'alpha', {
            spawnImpl: fakeSpawn({
                stdout: [
                    match(join(root, 'daily.md'), 'alpha beta'),
                    match(join(root, 'folder', '.assets', 'hidden.md'), 'alpha hidden'),
                ],
            }),
        });

        assert.deepEqual(results, [{
            path: 'daily.md',
            line: 1,
            content: 'alpha beta',
            context: 'alpha beta',
            kind: 'content',
        }]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('notes search returns filename and path matches before content matches', async () => {
    const root = tmpRoot();
    try {
        mkdirSync(join(root, 'projects'), { recursive: true });
        writeFileSync(join(root, 'projects', 'alpha-plan.md'), 'body without the token\n');
        writeFileSync(join(root, 'projects', 'body.md'), 'alpha in body\n');

        const results = await searchNotes(root, 'alpha', {
            spawnImpl: fakeSpawn({
                stdout: [match(join(root, 'projects', 'body.md'), 'alpha in body')],
            }),
        });

        assert.deepEqual(results.map(result => [result.kind, result.path]), [
            ['path', 'projects/alpha-plan.md'],
            ['content', 'projects/body.md'],
        ]);
        assert.equal(results[0]?.context, 'projects/alpha-plan.md');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('notes search treats no matches as an empty array', async () => {
    const results = await searchNotes(tmpRoot(), 'missing', {
        spawnImpl: fakeSpawn({ code: 1 }),
    });

    assert.deepEqual(results, []);
});

test('notes search maps missing rg and invalid regex to typed errors', async () => {
    await assert.rejects(
        searchNotes(tmpRoot(), 'alpha', { spawnImpl: fakeSpawn({ errorCode: 'ENOENT' }) }),
        { statusCode: 501, code: 'notes_search_unavailable' },
    );

    await assert.rejects(
        searchNotes(tmpRoot(), '(a', {
            regex: true,
            spawnImpl: fakeSpawn({ code: 2, stderr: ['regex parse error: missing )'] }),
        }),
        { statusCode: 400, code: 'invalid_note_search_regex' },
    );
});

test('notes search enforces a global result limit by killing rg early', async () => {
    const root = tmpRoot();
    let killed = false;
    try {
        const results = await searchNotes(root, 'alpha', {
            limit: 1,
            spawnImpl: fakeSpawn({
                stdout: [
                    match(join(root, 'one.md'), 'alpha one'),
                    match(join(root, 'two.md'), 'alpha two'),
                ],
                onKill: () => { killed = true; },
            }),
        });

        assert.equal(results.length, 1);
        assert.equal(killed, true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('notes search validates query and limit', async () => {
    await assert.rejects(searchNotes(tmpRoot(), 'a'), { statusCode: 400, code: 'invalid_note_search_query' });
    await assert.rejects(searchNotes(tmpRoot(), 'alpha', { limit: Number.NaN }), {
        statusCode: 400,
        code: 'invalid_note_search_limit',
    });
});
