import type { FolderPanelEntry } from './folder-sources';

export const FOLDER_PANEL_DRAG_MIME = 'application/x-cli-jaw-folder-entry';

type FolderPanelDragSelectionInput = {
    primaryEntry: FolderPanelEntry;
    entries: FolderPanelEntry[];
};

export type FolderPanelDragPayload = {
    path: string;
    name: string;
    kind: 'file' | 'directory';
    primaryPath?: string;
    entries?: Array<{ path: string; name: string; kind: 'file' | 'directory' }>;
};

export function encodeFolderPanelDragPayload(input: FolderPanelEntry | FolderPanelDragSelectionInput): string {
    if ('primaryEntry' in input) {
        const primary = input.primaryEntry;
        return JSON.stringify({
            path: primary.path,
            name: primary.name,
            kind: primary.kind,
            primaryPath: primary.path,
            entries: input.entries.map(entry => ({ path: entry.path, name: entry.name, kind: entry.kind })),
        });
    }
    return JSON.stringify({ path: input.path, name: input.name, kind: input.kind });
}

export function decodeFolderPanelDragPayload(value: string): FolderPanelDragPayload | null {
    try {
        const parsed = JSON.parse(value) as Partial<FolderPanelDragPayload>;
        if (typeof parsed.path !== 'string' || parsed.path.length === 0) return null;
        if (typeof parsed.name !== 'string' || parsed.name.length === 0) return null;
        if (parsed.kind !== 'file' && parsed.kind !== 'directory') return null;
        const entries = Array.isArray(parsed.entries)
            ? parsed.entries.filter(entry => (
                typeof entry?.path === 'string'
                && entry.path.length > 0
                && typeof entry.name === 'string'
                && entry.name.length > 0
                && (entry.kind === 'file' || entry.kind === 'directory')
            ))
            : undefined;
        return {
            path: parsed.path,
            name: parsed.name,
            kind: parsed.kind,
            ...(typeof parsed.primaryPath === 'string' && parsed.primaryPath.length > 0 ? { primaryPath: parsed.primaryPath } : {}),
            ...(entries && entries.length > 0 ? { entries } : {}),
        };
    } catch {
        return null;
    }
}

export function hasFolderPanelDragPayload(dataTransfer: DataTransfer | null): boolean {
    if (!dataTransfer) return false;
    return Array.from(dataTransfer.types).includes(FOLDER_PANEL_DRAG_MIME);
}

export function readFolderPanelDragPayload(dataTransfer: DataTransfer | null): FolderPanelDragPayload | null {
    if (!hasFolderPanelDragPayload(dataTransfer)) return null;
    return decodeFolderPanelDragPayload(dataTransfer!.getData(FOLDER_PANEL_DRAG_MIME));
}

export function shellEscapePath(path: string): string {
    return `'${path.replace(/'/g, `'\\''`)}'`;
}
