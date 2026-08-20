// Phase 9.1: path-guards 단위 테스트
// src/security/path-guards.js 가 생성되면 통과
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSkillId, assertFilename, safeResolveUnder, assertSendFilePath, sendFileAllowedRoots } from '../../src/security/path-guards.ts';
import { expandHomePath } from '../../src/core/path-expand.ts';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// ─── assertSkillId ───────────────────────────────────

test('PG-001: assertSkillId accepts simple name', () => {
    assert.equal(assertSkillId('dev'), 'dev');
});

test('PG-002: assertSkillId accepts dot-dash name', () => {
    assert.equal(assertSkillId('dev-backend'), 'dev-backend');
    assert.equal(assertSkillId('skill.v2'), 'skill.v2');
});

test('PG-003: assertSkillId rejects traversal (..)', () => {
    assert.throws(() => assertSkillId('../dev'), /invalid_skill_id|path_segment/);
});

test('PG-004: assertSkillId rejects slash', () => {
    assert.throws(() => assertSkillId('dev/x'), /invalid_skill_id|path_segment/);
});

test('PG-005: assertSkillId rejects backslash', () => {
    assert.throws(() => assertSkillId('dev\\x'), /invalid_skill_id|path_segment/);
});

test('PG-006: assertSkillId rejects empty', () => {
    assert.throws(() => assertSkillId(''), /invalid_skill_id/);
    assert.throws(() => assertSkillId(null), /invalid_skill_id/);
    assert.throws(() => assertSkillId(undefined), /invalid_skill_id/);
});

// ─── assertFilename ──────────────────────────────────

test('PG-007: assertFilename accepts valid .md', () => {
    assert.equal(assertFilename('notes.md'), 'notes.md');
    assert.equal(assertFilename('daily-2026.md'), 'daily-2026.md');
});

test('PG-008: assertFilename rejects wrong extension', () => {
    assert.throws(() => assertFilename('script.js', { allowExt: ['.md'] }), /invalid_extension/);
});

test('PG-009: assertFilename accepts multiple extensions', () => {
    assert.equal(
        assertFilename('image.png', { allowExt: ['.png', '.jpg', '.webp'] }),
        'image.png',
    );
});

test('PG-010: assertFilename rejects traversal in name', () => {
    assert.throws(() => assertFilename('../notes.md'), /invalid_filename/);
});

test('PG-011: assertFilename rejects empty/null', () => {
    assert.throws(() => assertFilename(''), /invalid_filename/);
    assert.throws(() => assertFilename(null), /invalid_filename/);
});

test('PG-012: assertFilename rejects overlong name', () => {
    assert.throws(() => assertFilename('a'.repeat(250) + '.md'), /invalid_filename/);
});

// ─── safeResolveUnder ────────────────────────────────

const BASE = '/tmp/test-memory';

test('PG-013: safeResolveUnder allows normal filename', () => {
    const p = safeResolveUnder(BASE, 'daily.md');
    assert.equal(p, path.resolve(BASE, 'daily.md'));
});

test('PG-014: safeResolveUnder blocks traversal (..)', () => {
    assert.throws(() => safeResolveUnder(BASE, '../etc/passwd'), /path_escape/);
});

test('PG-015: safeResolveUnder blocks absolute path', () => {
    assert.throws(() => safeResolveUnder(BASE, '/etc/passwd'), /path_escape/);
});

test('PG-016: safeResolveUnder blocks encoded traversal (..%2f)', () => {
    // decodeURIComponent happens before this function, so raw % isn't a traversal,
    // but if decoded value escapes base, it should be caught
    assert.throws(() => safeResolveUnder(BASE, '../../etc/passwd'), /path_escape/);
});

test('PG-017: expandHomePath handles POSIX and Windows tilde separators', () => {
    assert.equal(expandHomePath('~/jaw', '/home/user'), '/home/user/jaw');
    assert.equal(expandHomePath('~\\jaw', 'C:\\Users\\jun'), 'C:\\Users\\jun\\jaw');
    assert.equal(expandHomePath('~', '/Users/jun'), '/Users/jun');
});

test('PG-018: assertSendFilePath uses CLI_JAW_HOME/os.homedir instead of HOME-only fallback', () => {
    const previousCliHome = process.env.CLI_JAW_HOME;
    const previousJawHome = process.env.JAW_HOME;
    const previousHome = process.env.HOME;
    const testHome = path.join(os.tmpdir(), 'jaw-send-path-home');
    const allowedFile = path.join(testHome, 'out.txt');
    try {
        fs.mkdirSync(testHome, { recursive: true });
        fs.writeFileSync(allowedFile, 'ok');
        process.env.CLI_JAW_HOME = testHome;
        delete process.env.JAW_HOME;
        delete process.env.HOME;
        assert.equal(assertSendFilePath(allowedFile), fs.realpathSync.native(allowedFile));
    } finally {
        if (previousCliHome == null) delete process.env.CLI_JAW_HOME;
        else process.env.CLI_JAW_HOME = previousCliHome;
        if (previousJawHome == null) delete process.env.JAW_HOME;
        else process.env.JAW_HOME = previousJawHome;
        if (previousHome == null) delete process.env.HOME;
        else process.env.HOME = previousHome;
        fs.rmSync(testHome, { recursive: true, force: true });
    }
});

test('PG-019: assertSendFilePath rejects arbitrary tmp files outside allowed roots', () => {
    const previousCliHome = process.env.CLI_JAW_HOME;
    const previousJawHome = process.env.JAW_HOME;
    const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-send-path-home-'));
    const tmpFile = path.join(os.tmpdir(), `jaw-send-path-denied-${Date.now()}.txt`);
    try {
        fs.writeFileSync(tmpFile, 'secret');
        process.env.CLI_JAW_HOME = testHome;
        delete process.env.JAW_HOME;
        assert.throws(() => assertSendFilePath(tmpFile), /path_not_allowed/);
    } finally {
        if (previousCliHome == null) delete process.env.CLI_JAW_HOME;
        else process.env.CLI_JAW_HOME = previousCliHome;
        if (previousJawHome == null) delete process.env.JAW_HOME;
        else process.env.JAW_HOME = previousJawHome;
        fs.rmSync(testHome, { recursive: true, force: true });
        fs.rmSync(tmpFile, { force: true });
    }
});

test('PG-020: assertSendFilePath allows files under workingDir', () => {
    const previousCliHome = process.env.CLI_JAW_HOME;
    const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-send-path-home-'));
    const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-send-path-working-'));
    const allowedFile = path.join(workingDir, 'report.txt');
    try {
        process.env.CLI_JAW_HOME = testHome;
        fs.writeFileSync(allowedFile, 'ok');
        assert.equal(assertSendFilePath(allowedFile, workingDir), fs.realpathSync.native(allowedFile));
    } finally {
        if (previousCliHome == null) delete process.env.CLI_JAW_HOME;
        else process.env.CLI_JAW_HOME = previousCliHome;
        fs.rmSync(testHome, { recursive: true, force: true });
        fs.rmSync(workingDir, { recursive: true, force: true });
    }
});

test('PG-021: assertSendFilePath allows files under exact projectDirs realpath roots', () => {
    const previousCliHome = process.env.CLI_JAW_HOME;
    const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-send-path-home-'));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-send-path-project-'));
    const allowedFile = path.join(projectDir, 'artifact.png');
    try {
        process.env.CLI_JAW_HOME = testHome;
        fs.writeFileSync(allowedFile, 'ok');
        const canonicalProjectDir = fs.realpathSync.native(projectDir);
        assert.equal(assertSendFilePath(allowedFile, undefined, [canonicalProjectDir]), fs.realpathSync.native(allowedFile));
    } finally {
        if (previousCliHome == null) delete process.env.CLI_JAW_HOME;
        else process.env.CLI_JAW_HOME = previousCliHome;
        fs.rmSync(testHome, { recursive: true, force: true });
        fs.rmSync(projectDir, { recursive: true, force: true });
    }
});

test('PG-022: assertSendFilePath rejects symlink escape from allowed workingDir', { skip: process.platform === 'win32' }, () => {
    const previousCliHome = process.env.CLI_JAW_HOME;
    const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-send-path-home-'));
    const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-send-path-working-'));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-send-path-outside-'));
    const outsideFile = path.join(outsideDir, 'secret.txt');
    const linkPath = path.join(workingDir, 'secret-link.txt');
    try {
        process.env.CLI_JAW_HOME = testHome;
        fs.writeFileSync(outsideFile, 'secret');
        fs.symlinkSync(outsideFile, linkPath);
        assert.throws(() => assertSendFilePath(linkPath, workingDir), /path_not_allowed/);
    } finally {
        if (previousCliHome == null) delete process.env.CLI_JAW_HOME;
        else process.env.CLI_JAW_HOME = previousCliHome;
        fs.rmSync(testHome, { recursive: true, force: true });
        fs.rmSync(workingDir, { recursive: true, force: true });
        fs.rmSync(outsideDir, { recursive: true, force: true });
    }
});

test('PG-023: assertSendFilePath rejects home files outside allowed roots', () => {
    const previousCliHome = process.env.CLI_JAW_HOME;
    const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-send-path-home-'));
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-send-path-user-home-'));
    const homeFile = path.join(fakeHome, 'private.txt');
    try {
        process.env.CLI_JAW_HOME = testHome;
        fs.writeFileSync(homeFile, 'private');
        assert.throws(() => assertSendFilePath(homeFile), /path_not_allowed/);
    } finally {
        if (previousCliHome == null) delete process.env.CLI_JAW_HOME;
        else process.env.CLI_JAW_HOME = previousCliHome;
        fs.rmSync(testHome, { recursive: true, force: true });
        fs.rmSync(fakeHome, { recursive: true, force: true });
    }
});

// ─── #404: a refusal that says where "allowed" is ───
//
// Refusing was right; refusing anonymously was not. The allowed roots live in
// settings the caller never reads, so six `path_not_allowed` errors landed in
// stderr and the agent simply stopped producing the file.

function withSendHome(run: (home: string) => void): void {
    const previousCliHome = process.env.CLI_JAW_HOME;
    const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-send-detail-home-'));
    try {
        process.env.CLI_JAW_HOME = testHome;
        run(fs.realpathSync(testHome));
    } finally {
        if (previousCliHome == null) delete process.env.CLI_JAW_HOME;
        else process.env.CLI_JAW_HOME = previousCliHome;
        fs.rmSync(testHome, { recursive: true, force: true });
    }
}

test('PG-024: a refused path carries the roots that would have worked', () => {
    withSendHome((home) => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-send-detail-outside-'));
        const file = path.join(outside, 'report.png');
        try {
            fs.writeFileSync(file, 'x');
            let thrown: unknown;
            try { assertSendFilePath(file); } catch (e) { thrown = e; }

            assert.ok(thrown, 'the path must still be refused');
            const err = thrown as { message: string; statusCode?: number; code?: string; detail?: Record<string, unknown> };
            // The contract that must NOT change: this is a 403 with this code.
            assert.equal(err.message, 'path_not_allowed');
            assert.equal(err.statusCode, 403, 'a 403 must not become a 500');
            assert.equal(err.code, 'path_not_allowed');

            const roots = err.detail?.['allowedRoots'] as string[] | undefined;
            assert.ok(Array.isArray(roots) && roots.length > 0, 'the refusal must name somewhere to go');
            assert.ok(roots.includes(home), `JAW_HOME must be listed; saw ${JSON.stringify(roots)}`);
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });
});

test('PG-025: the reported roots are the roots the guard enforces', () => {
    withSendHome((home) => {
        const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-send-detail-project-'));
        const missing = path.join(os.tmpdir(), 'jaw-send-detail-does-not-exist');
        try {
            const roots = sendFileAllowedRoots(undefined, [projectDir, missing]);
            assert.ok(roots.includes(home));
            assert.ok(roots.includes(fs.realpathSync(projectDir)), 'a configured project root is listed');
            // The guard skips a root it cannot resolve, so a reporter that listed
            // it would name a directory that grants nothing.
            assert.ok(!roots.some(r => r.includes('does-not-exist')), 'an unresolvable root is omitted');

            // Enforcement agrees: a file under the listed root is accepted.
            const inProject = path.join(projectDir, 'ok.png');
            fs.writeFileSync(inProject, 'x');
            assert.equal(
                assertSendFilePath(inProject, undefined, [projectDir]),
                fs.realpathSync(inProject),
            );
        } finally {
            fs.rmSync(projectDir, { recursive: true, force: true });
        }
    });
});

test('PG-026: the scope did not widen — JAW_HOME in, everything else out', () => {
    withSendHome((home) => {
        const inside = path.join(home, 'uploads');
        fs.mkdirSync(inside, { recursive: true });
        const okFile = path.join(inside, 'ok.png');
        fs.writeFileSync(okFile, 'x');
        assert.equal(assertSendFilePath(okFile), fs.realpathSync(okFile));

        // And the other refusals still refuse, with their statuses intact.
        for (const [input, expected] of [
            [path.join(home, 'missing.png'), 'path_not_resolvable'],
            [`${okFile}:hidden`, 'path_not_allowed'],
        ] as const) {
            let thrown: unknown;
            try { assertSendFilePath(input); } catch (e) { thrown = e; }
            const err = thrown as { message?: string; statusCode?: number } | undefined;
            assert.ok(err, `${input} must be refused`);
            assert.equal(err!.statusCode, 403, `${input} must stay a 403`);
            if (expected === 'path_not_resolvable') assert.equal(err!.message, expected);
        }
    });
});
