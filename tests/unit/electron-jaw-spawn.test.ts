import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasDashboardCommand } from '../../electron/src/main/lib/jaw-spawn.ts';

function writeExecutable(dir: string, name: string, content: string): string {
    const file = join(dir, name);
    writeFileSync(file, content, 'utf8');
    chmodSync(file, 0o755);
    return file;
}

test('electron jaw spawn rejects stale jaw binaries without dashboard command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaw-electron-spawn-'));
    try {
        const staleJaw = writeExecutable(dir, 'jaw-stale', `#!/bin/sh
if [ "$1" = "dashboard" ]; then
  echo "Unknown command: dashboard" >&2
  exit 1
fi
exit 0
`);

        assert.equal(hasDashboardCommand(staleJaw), false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('electron jaw spawn accepts jaw binaries with dashboard subcommands', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaw-electron-spawn-'));
    try {
        const currentJaw = writeExecutable(dir, 'jaw-current', `#!/bin/sh
if [ "$1" = "dashboard" ]; then
  echo "Unknown dashboard command: $2" >&2
  echo "Usage: jaw dashboard serve [options]" >&2
  exit 1
fi
exit 0
`);

        assert.equal(hasDashboardCommand(currentJaw), true);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
