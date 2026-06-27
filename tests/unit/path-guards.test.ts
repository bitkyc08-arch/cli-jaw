// Phase 9.1: path-guards 단위 테스트
// src/security/path-guards.js 가 생성되면 통과
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSkillId, assertFilename, safeResolveUnder, assertSendFilePath } from '../../src/security/path-guards.ts';
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
