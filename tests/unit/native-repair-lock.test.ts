import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const projectRoot = join(import.meta.dirname, '..', '..');
const guard = join(projectRoot, 'scripts', 'ensure-native-modules.cjs');

const require_ = createRequire(import.meta.url);
const lockApi = require_(guard) as {
    __testing?: {
        lockDir: string;
        acquire: (waitMs: number) => boolean;
        release: () => void;
    };
};

test('the lock is exclusive: a second acquire fails while it is held', { skip: !lockApi.__testing }, () => {
    const api = lockApi.__testing!;
    api.release();
    try {
        assert.equal(api.acquire(0), true, 'first acquire should succeed');
        assert.equal(api.acquire(0), false, 'second acquire must not succeed while held');
    } finally {
        api.release();
    }
    assert.equal(existsSync(api.lockDir), false, 'release must remove the lock');
});

test('a lock held by a live owner is never stolen', { skip: !lockApi.__testing }, () => {
    const api = lockApi.__testing!;
    api.release();
    try {
        assert.equal(api.acquire(0), true);
        // This process is unquestionably alive, so the lock must be respected
        // no matter how long the rebuild it guards has been running.
        writeFileSync(join(api.lockDir, 'owner'), String(process.pid));
        assert.equal(api.acquire(0), false, 'a live owner must not have its lock reclaimed');
    } finally {
        api.release();
    }
});

test('a lock abandoned by a dead process is reclaimed', { skip: !lockApi.__testing }, () => {
    const api = lockApi.__testing!;
    api.release();
    try {
        assert.equal(api.acquire(0), true);
        // A PID that cannot exist stands in for a crashed owner.
        writeFileSync(join(api.lockDir, 'owner'), '2147483646');
        assert.equal(api.acquire(0), true, 'a dead owner must not deadlock later runs');
    } finally {
        api.release();
    }
});

test('the repair lock is not stored inside node_modules', { skip: !lockApi.__testing }, () => {
    assert.ok(
        !lockApi.__testing!.lockDir.includes('node_modules'),
        'a concurrent npm install could delete the lock mid-hold',
    );
});

test('a missing install is reported without acquiring a repair lock', () => {
    // A pruned install must not leave a lock behind for the next process to wait on.
    const root = mkdtempSync(join(tmpdir(), 'jaw-lock-'));
    try {
        mkdirSync(join(root, 'scripts'), { recursive: true });
        mkdirSync(join(root, 'node_modules'), { recursive: true });
        writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'probe', version: '0.0.0' }));
        execFileSync('cp', [guard, join(root, 'scripts', 'ensure-native-modules.cjs')]);

        let status = 0;
        try {
            execFileSync(process.execPath, [join(root, 'scripts', 'ensure-native-modules.cjs')], {
                cwd: root,
                stdio: 'pipe',
            });
        } catch (error) {
            status = (error as { status?: number }).status ?? 1;
        }

        assert.notEqual(status, 0, 'a missing install must fail loudly');
        assert.equal(
            existsSync(join(root, 'node_modules', '.jaw-native-rebuild.lock')),
            false,
            'no lock should be created when there is nothing to repair',
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
