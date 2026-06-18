import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

export function makeDashboardTempDir(t: TestContext, prefix: string): string {
    const root = join(homedir(), '.cli-jaw-dashboard', 'test-tmp');
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(join(root, prefix));
    t.after(() => {
        rmSync(dir, { recursive: true, force: true });
    });
    return dir;
}
