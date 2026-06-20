import { app } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const STORE_FILE = 'folder-approved-roots.json';

type ApprovedRootsStore = {
    roots?: unknown;
};

function approvedRootsStorePath(): string {
    return join(app.getPath('userData'), STORE_FILE);
}

function normalizeApprovedRoots(paths: string[]): string[] {
    const roots = new Set<string>();
    for (const path of paths) {
        const trimmed = path.trim();
        if (trimmed) roots.add(resolve(trimmed));
    }
    return [...roots].sort((a, b) => a.localeCompare(b));
}

export async function loadApprovedFolderRoots(): Promise<string[]> {
    try {
        const raw = await readFile(approvedRootsStorePath(), 'utf8');
        const parsed = JSON.parse(raw) as ApprovedRootsStore;
        if (!Array.isArray(parsed.roots)) return [];
        return normalizeApprovedRoots(parsed.roots.filter((root): root is string => typeof root === 'string'));
    } catch {
        return [];
    }
}

export async function saveApprovedFolderRoots(paths: string[]): Promise<void> {
    const roots = normalizeApprovedRoots(paths);
    const filePath = approvedRootsStorePath();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify({ roots }, null, 2)}\n`, 'utf8');
}

export async function rememberApprovedFolderRoot(path: string): Promise<string[]> {
    const roots = normalizeApprovedRoots([...await loadApprovedFolderRoots(), path]);
    await saveApprovedFolderRoots(roots);
    return roots;
}
