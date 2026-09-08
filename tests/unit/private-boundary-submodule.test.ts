// The private-record boundary is about disclosure, and a submodule is
// published alongside its superproject. But gitlinks are opaque to
// `git ls-files` and `git ls-tree`: both stop at the pointer. A private path
// committed inside a submodule was therefore invisible to a check that walked
// only the superproject.
//
// This was not hypothetical. The check reported OK while the public
// cli-jaw-skills repository carried devlog/_fin and devlog/_plan records at its
// root, because the superproject stores it as a single gitlink entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkIndex, isPrivatePath, reportSubmodules } from '../../scripts/check-private-boundary.mjs';

function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function repo(dir: string): string {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'test@example.invalid']);
    git(dir, ['config', 'user.name', 'test']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    git(dir, ['config', 'protocol.file.allow', 'always']);
    return dir;
}

function commitFile(dir: string, rel: string, body: string): void {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'add ' + rel]);
}

test('PBS-001: a private path inside a submodule is found, and enforced on request', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pbs-'));
    try {
        const sub = repo(path.join(root, 'sub'));
        commitFile(sub, 'devlog/_plan/260908_x/000_index.md', 'private record\n');

        const parent = repo(path.join(root, 'parent'));
        commitFile(parent, 'README.md', 'public\n');
        git(parent, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'skills_ref']);
        git(parent, ['commit', '-q', '-m', 'add submodule']);

        // Reported by default: the superproject's own ls-files cannot see this.
        const findings = reportSubmodules(parent);
        assert.equal(findings.length, 1);
        assert.deepEqual(findings[0].files, ['skills_ref/devlog/_plan/260908_x/000_index.md']);

        // Enforced only when asked, because the live submodule tip still
        // carries records that predate this check.
        assert.throws(
            () => reportSubmodules(parent, { enforce: true }),
            /skills_ref\/devlog\/_plan\/260908_x\/000_index\.md/,
            'enforce mode must reject the submodule content',
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('PBS-002: a clean submodule passes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pbs-'));
    try {
        const sub = repo(path.join(root, 'sub'));
        commitFile(sub, 'skills/example/SKILL.md', 'public skill\n');

        const parent = repo(path.join(root, 'parent'));
        commitFile(parent, 'README.md', 'public\n');
        git(parent, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'skills_ref']);
        git(parent, ['commit', '-q', '-m', 'add submodule']);

        assert.doesNotThrow(() => checkIndex(parent));
        assert.deepEqual(reportSubmodules(parent, { enforce: true }), []);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('PBS-003: a repository with no submodules still passes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pbs-'));
    try {
        const plain = repo(path.join(root, 'plain'));
        commitFile(plain, 'src/index.ts', 'export {};\n');
        assert.doesNotThrow(() => checkIndex(plain));
        assert.deepEqual(reportSubmodules(plain, { enforce: true }), []);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('PBS-004: the private-path predicate is unchanged by submodule prefixing', () => {
    assert.equal(isPrivatePath('skills_ref/devlog/_plan/x/000.md'), true);
    assert.equal(isPrivatePath('skills_ref/_fin/x.md'), true);
    assert.equal(isPrivatePath('skills_ref/skills/example/SKILL.md'), false);
    // A path merely containing the word is not a private record.
    assert.equal(isPrivatePath('src/devlogger/index.ts'), false);
});
