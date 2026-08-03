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
