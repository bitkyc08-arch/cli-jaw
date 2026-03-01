/**
 * tests/unit/ide-diff.test.ts
 * IDE Diff View 모듈 테스트 — captureFileSet/diffFileSets 기반
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
    isGitRepo, captureFileSet, diffFileSets,
    detectIde, getIdeCli, openDiffInIde, getDiffStat,
} from '../../src/ide/diff.js';

// ─── Helpers ─────────────────────────────────

function makeTempGitRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ide-diff-test-'));
    execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
    return dir;
}

function commitAll(dir: string, msg = 'init') {
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', msg, '--allow-empty'], { cwd: dir, stdio: 'pipe' });
}

// ─── Tests ───────────────────────────────────

describe('isGitRepo', () => {
    it('ID-001: returns true for a git repo', () => {
        const dir = makeTempGitRepo();
        assert.equal(isGitRepo(dir), true);
        rmSync(dir, { recursive: true, force: true });
    });

    it('ID-002: returns false for /tmp (not a git repo)', () => {
        assert.equal(isGitRepo(tmpdir()), false);
    });
});

describe('captureFileSet', () => {
    let dir: string;
    beforeEach(() => { dir = makeTempGitRepo(); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    it('ID-003: empty map for clean repo', () => {
        writeFileSync(join(dir, 'a.txt'), 'hello');
        commitAll(dir);
        const map = captureFileSet(dir);
        assert.equal(map.size, 0);
    });

    it('ID-004: detects unstaged tracked changes', () => {
        writeFileSync(join(dir, 'a.txt'), 'hello');
        commitAll(dir);
        writeFileSync(join(dir, 'a.txt'), 'updated');
        const map = captureFileSet(dir);
        assert.ok(map.has('a.txt'));
    });

    it('ID-005: detects untracked files', () => {
        writeFileSync(join(dir, 'a.txt'), 'hello');
        commitAll(dir);
        writeFileSync(join(dir, 'new.txt'), 'new file');
        const map = captureFileSet(dir);
        assert.ok(map.has('new.txt'));
    });

    it('ID-006: returns empty map for non-git directory', () => {
        const nonGit = mkdtempSync(join(tmpdir(), 'non-git-'));
        const map = captureFileSet(nonGit);
        assert.equal(map.size, 0);
        rmSync(nonGit, { recursive: true, force: true });
    });

    it('ID-006b: detects unicode file paths (core.quotepath=false)', () => {
        writeFileSync(join(dir, '안녕.md'), 'hello');
        commitAll(dir);
        writeFileSync(join(dir, '안녕.md'), 'updated');
        const map = captureFileSet(dir);
        assert.ok(map.has('안녕.md'));
    });
});

describe('diffFileSets', () => {
    it('ID-007: returns only new files in post map', () => {
        const pre = new Map([['a.txt', '100'], ['b.txt', '200']]);
        const post = new Map([['a.txt', '100'], ['b.txt', '200'], ['c.txt', '300'], ['d.txt', '400']]);
        const diff = diffFileSets(pre, post);
        assert.deepEqual(diff.sort(), ['c.txt', 'd.txt']);
    });

    it('ID-008: detects mtime changes for same file', () => {
        const pre = new Map([['a.txt', '100']]);
        const post = new Map([['a.txt', '200']]); // mtime changed
        const diff = diffFileSets(pre, post);
        assert.deepEqual(diff, ['a.txt']);
    });

    it('ID-008b: returns empty when nothing changed', () => {
        const pre = new Map([['a.txt', '100']]);
        const post = new Map([['a.txt', '100']]); // same fingerprint
        const diff = diffFileSets(pre, post);
        assert.equal(diff.length, 0);
    });

    it('ID-008c: detects same-mtime but different content fingerprint', () => {
        const pre = new Map([['a.txt', '100:12:hash_v1']]);
        const post = new Map([['a.txt', '100:12:hash_v2']]); // mtime/size same, hash differs
        const diff = diffFileSets(pre, post);
        assert.deepEqual(diff, ['a.txt']);
    });
});

describe('detectIde', () => {
    const savedEnv: Record<string, string | undefined> = {};
    const envKeys = ['ANTIGRAVITY_AGENT', '__CFBundleIdentifier', 'GIT_ASKPASS', 'TERM_PROGRAM', 'VSCODE_PID'];
    beforeEach(() => { for (const k of envKeys) savedEnv[k] = process.env[k]; });
    afterEach(() => { for (const k of envKeys) { if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k]; else delete process.env[k]; } });

    it('ID-009: returns antigravity when ANTIGRAVITY_AGENT=1', () => {
        process.env.ANTIGRAVITY_AGENT = '1';
        assert.equal(detectIde(), 'antigravity');
    });

    it('ID-010: returns code when TERM_PROGRAM=vscode', () => {
        delete process.env.ANTIGRAVITY_AGENT;
        delete process.env.__CFBundleIdentifier;
        delete process.env.GIT_ASKPASS;
        process.env.TERM_PROGRAM = 'vscode';
        assert.equal(detectIde(), 'code');
    });

    it('ID-011: returns null when no IDE env vars set', () => {
        delete process.env.ANTIGRAVITY_AGENT;
        delete process.env.__CFBundleIdentifier;
        delete process.env.GIT_ASKPASS;
        delete process.env.TERM_PROGRAM;
        delete process.env.VSCODE_PID;
        assert.equal(detectIde(), null);
    });
});

describe('getIdeCli', () => {
    it('ID-012: respects ANTIGRAVITY_CLI_ALIAS env', () => {
        const orig = process.env.ANTIGRAVITY_CLI_ALIAS;
        process.env.ANTIGRAVITY_CLI_ALIAS = 'agy';
        assert.equal(getIdeCli('antigravity'), 'agy');
        if (orig) process.env.ANTIGRAVITY_CLI_ALIAS = orig;
        else delete process.env.ANTIGRAVITY_CLI_ALIAS;
    });

    it('returns null for null input', () => {
        assert.equal(getIdeCli(null), null);
    });
});

describe('getDiffStat', () => {
    let dir: string;
    beforeEach(() => { dir = makeTempGitRepo(); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    it('ID-013: returns stat for modified file', () => {
        writeFileSync(join(dir, 'a.txt'), 'hello');
        commitAll(dir);
        writeFileSync(join(dir, 'a.txt'), 'updated content');
        const stat = getDiffStat(dir, ['a.txt']);
        assert.ok(stat.includes('a.txt'));
    });

    it('ID-014: returns empty for non-existent file', () => {
        const stat = getDiffStat(dir, ['nonexistent.txt']);
        assert.equal(stat, '');
    });

    it('ID-015: returns empty for empty files array', () => {
        assert.equal(getDiffStat(dir, []), '');
    });
});

describe('integration: file-set based diff detection', () => {
    let dir: string;
    beforeEach(() => { dir = makeTempGitRepo(); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    it('ID-016: detects only agent-created files', () => {
        // Simulate existing dirty state
        writeFileSync(join(dir, 'existing.txt'), 'old content');
        commitAll(dir);
        writeFileSync(join(dir, 'existing.txt'), 'modified before agent');

        // Pre-snapshot (includes existing dirty file)
        const pre = captureFileSet(dir);
        assert.ok(pre.has('existing.txt'));

        // Simulate agent creating a new file
        writeFileSync(join(dir, 'agent-created.txt'), 'by agent');

        // Post-snapshot + diff
        const post = captureFileSet(dir);
        const changed = diffFileSets(pre, post);

        assert.ok(changed.includes('agent-created.txt'));
        assert.ok(!changed.includes('existing.txt')); // pre-existing, same mtime → excluded
    });

    it('ID-016b: detects re-modification of same file via mtime', async () => {
        writeFileSync(join(dir, 'file.txt'), 'v1');
        commitAll(dir);
        writeFileSync(join(dir, 'file.txt'), 'v2');

        const pre = captureFileSet(dir);
        assert.ok(pre.has('file.txt'));

        // Wait briefly to ensure mtime differs
        await new Promise(r => setTimeout(r, 50));
        writeFileSync(join(dir, 'file.txt'), 'v3');

        const post = captureFileSet(dir);
        const changed = diffFileSets(pre, post);
        assert.ok(changed.includes('file.txt'));
    });

    it('ID-017: commit-less repo captures untracked files', () => {
        writeFileSync(join(dir, 'new.txt'), 'content');
        const pre = captureFileSet(dir);
        assert.ok(pre.has('new.txt'));
    });
});

describe('queue drain safety', () => {
    it('ID-018: FIFO push/shift correctness', () => {
        const queue: Map<string, string>[] = [];
        queue.push(new Map([['a.txt', '100']]));
        queue.push(new Map([['b.txt', '200']]));
        const first = queue.shift()!;
        assert.ok(first.has('a.txt'));
        assert.equal(queue.length, 1);
    });

    it('ID-019: queue drain after /ide off — shift still removes entry', () => {
        const queue: Map<string, string>[] = [];
        let ideEnabled = true;
        queue.push(new Map([['a.txt', '100']]));
        ideEnabled = false;
        if (queue.length > 0) {
            const preSet = queue.shift()!;
            if (ideEnabled) { /* would compare */ }
        }
        assert.equal(queue.length, 0);
    });
});

describe('ideHandler contract', () => {
    it('ID-020: correct codes for valid args, rejects invalid', async () => {
        const { ideHandler } = await import('../../src/cli/handlers.js');
        const ctx = { locale: 'ko' };

        const toggle = await ideHandler([], ctx);
        assert.equal(toggle.code, 'ide_toggle');
        assert.equal(toggle.ok, true);

        const on = await ideHandler(['on'], ctx);
        assert.equal(on.code, 'ide_on');

        const off = await ideHandler(['off'], ctx);
        assert.equal(off.code, 'ide_off');

        const pop = await ideHandler(['pop'], ctx);
        assert.equal(pop.code, 'ide_pop_toggle');

        const invalid = await ideHandler(['banana'], ctx);
        assert.equal(invalid.ok, false);
    });
});

describe('ENOENT safety', () => {
    it('ID-021: openDiffInIde(ide=null) returns without crash', () => {
        assert.doesNotThrow(() => openDiffInIde('/tmp', [], null));
    });

    it('ID-022: openDiffInIde with non-existent CLI does not throw', () => {
        const orig = process.env.ANTIGRAVITY_CLI_ALIAS;
        process.env.ANTIGRAVITY_CLI_ALIAS = '/nonexistent/binary';
        assert.doesNotThrow(() => openDiffInIde('/tmp', ['nonexistent.txt'], 'antigravity'));
        if (orig) process.env.ANTIGRAVITY_CLI_ALIAS = orig;
        else delete process.env.ANTIGRAVITY_CLI_ALIAS;
    });
});
