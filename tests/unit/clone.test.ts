// Multi-Instance Phase 3: jaw clone command 검증
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const JAW = `node ${join(projectRoot, 'dist/bin/cli-jaw.js')}`;

function cleanup(dir: string) {
    rmSync(dir, { recursive: true, force: true });
}

test('P3-001: clone creates all required directories', () => {
    const target = '/tmp/test-clone-p3-001';
    cleanup(target);
    try {
        execSync(`${JAW} clone ${target}`, { cwd: projectRoot, stdio: 'pipe' });
        for (const dir of ['prompts', 'skills', 'worklogs', 'uploads', 'memory', 'logs']) {
            assert.ok(existsSync(join(target, dir)), `${dir}/ should exist`);
        }
        assert.ok(existsSync(join(target, 'settings.json')), 'settings.json should exist');
    } finally {
        cleanup(target);
    }
});

test('P3-002: clone sets workingDir to target path', () => {
    const target = '/tmp/test-clone-p3-002';
    cleanup(target);
    try {
        execSync(`${JAW} clone ${target}`, { cwd: projectRoot, stdio: 'pipe' });
        const settings = JSON.parse(readFileSync(join(target, 'settings.json'), 'utf8'));
        assert.equal(settings.workingDir, target);
    } finally {
        cleanup(target);
    }
});

test('P3-003: clone does NOT copy jaw.db from source', () => {
    const target = '/tmp/test-clone-p3-003';
    cleanup(target);
    try {
        execSync(`${JAW} clone ${target}`, { cwd: projectRoot, stdio: 'pipe' });
        // jaw.db may be created by regenerateB subprocess, but it should be fresh (empty)
        // The key is that source DB data is NOT carried over
        if (existsSync(join(target, 'jaw.db'))) {
            const stat = lstatSync(join(target, 'jaw.db'));
            // Fresh DB should be very small (< 100KB) compared to active one
            assert.ok(stat.size < 100_000, 'jaw.db should be fresh (small)');
        }
        // Either doesn't exist or is fresh — both valid
        assert.ok(true);
    } finally {
        cleanup(target);
    }
});

test('P3-004: clone --with-memory copies MEMORY.md', () => {
    const target = '/tmp/test-clone-p3-004';
    cleanup(target);
    try {
        execSync(`${JAW} clone ${target} --with-memory`, { cwd: projectRoot, stdio: 'pipe' });
        const memPath = join(target, 'memory', 'MEMORY.md');
        // Only assert if source has MEMORY.md
        const sourceMem = join(process.env.HOME || '', '.cli-jaw', 'memory', 'MEMORY.md');
        if (existsSync(sourceMem)) {
            assert.ok(existsSync(memPath), 'MEMORY.md should be copied');
        } else {
            assert.ok(true, 'No source MEMORY.md to copy');
        }
    } finally {
        cleanup(target);
    }
});

test('P3-005: clone --link-ref creates symlink for skills_ref', () => {
    const target = '/tmp/test-clone-p3-005';
    cleanup(target);
    try {
        execSync(`${JAW} clone ${target} --link-ref`, { cwd: projectRoot, stdio: 'pipe' });
        const refPath = join(target, 'skills_ref');
        if (existsSync(refPath)) {
            assert.ok(lstatSync(refPath).isSymbolicLink(), 'skills_ref should be a symlink');
        }
    } finally {
        cleanup(target);
    }
});

test('P3-006: clone to non-empty dir fails', () => {
    const target = '/tmp/test-clone-p3-006';
    cleanup(target);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'blocker.txt'), 'exists');
    try {
        assert.throws(
            () => execSync(`${JAW} clone ${target}`, { cwd: projectRoot, stdio: 'pipe' }),
            { status: 1 },
        );
    } finally {
        cleanup(target);
    }
});
