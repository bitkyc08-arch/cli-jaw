import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Page snapshots (186 Phase 2, OD-5): copy artifact.html + page.json +
 * prompt.md into snapshots/<stamp>-<label>/. Keep-last-20 per page; restore
 * always goes through a recovery snapshot first (store.ts owns that rule).
 */

export type DesignSnapshotInfo = {
    id: string;
    label: 'before' | 'after' | 'recovery' | 'manual';
    createdAt: string;
};

const SNAPSHOT_FILES = ['artifact.html', 'page.json', 'prompt.md'];
const SNAPSHOT_KEEP = 20;

function snapshotsDir(pageDir: string): string {
    return join(pageDir, 'snapshots');
}

function parseSnapshotId(id: string): DesignSnapshotInfo | null {
    const match = /^(\d+)-(before|after|recovery|manual)$/.exec(id);
    if (!match) return null;
    return {
        id,
        label: match[2] as DesignSnapshotInfo['label'],
        createdAt: new Date(Number(match[1])).toISOString(),
    };
}

export function createDesignSnapshot(pageDir: string, label: DesignSnapshotInfo['label']): DesignSnapshotInfo {
    const id = `${Date.now()}-${label}`;
    const dir = join(snapshotsDir(pageDir), id);
    mkdirSync(dir, { recursive: true });
    for (const name of SNAPSHOT_FILES) {
        const source = join(pageDir, name);
        if (existsSync(source)) copyFileSync(source, join(dir, name));
    }
    pruneDesignSnapshots(pageDir);
    return parseSnapshotId(id)!;
}

export function listDesignSnapshots(pageDir: string): DesignSnapshotInfo[] {
    const dir = snapshotsDir(pageDir);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .map(parseSnapshotId)
        .filter((info): info is DesignSnapshotInfo => info !== null)
        .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
}

export function restoreDesignSnapshot(pageDir: string, snapshotId: string): { ok: true } | { ok: false; error: string } {
    const info = parseSnapshotId(snapshotId);
    if (!info) return { ok: false, error: `invalid snapshot id: ${snapshotId}` };
    const dir = join(snapshotsDir(pageDir), snapshotId);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return { ok: false, error: `snapshot not found: ${snapshotId}` };
    for (const name of SNAPSHOT_FILES) {
        const source = join(dir, name);
        if (existsSync(source)) copyFileSync(source, join(pageDir, name));
    }
    return { ok: true };
}

export function pruneDesignSnapshots(pageDir: string, keep = SNAPSHOT_KEEP): void {
    const snapshots = listDesignSnapshots(pageDir);
    for (const stale of snapshots.slice(keep)) {
        try {
            rmSync(join(snapshotsDir(pageDir), stale.id), { recursive: true, force: true });
        } catch { /* best effort */ }
    }
}
