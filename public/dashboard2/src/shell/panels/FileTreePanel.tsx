import {
    ChevronDown,
    ChevronRight,
    File,
    FileCode,
    FileJson,
    FileText,
    Folder,
    FolderOpen,
    LoaderCircle,
} from '@lucide/icons';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useDesktopBridge } from '../../providers/desktop-bridge-provider.tsx';
import { useAppScope } from '../../state/scope.tsx';
import { Icon } from '../Icon.tsx';

interface FileEntry {
    name: string;
    path: string;
    isDirectory: boolean;
}

interface TreeNode extends FileEntry {
    depth: number;
}

type DirectoryState =
    | { status: 'loading' }
    | { status: 'loaded'; entries: FileEntry[] }
    | { status: 'error'; message: string };

const CODE_EXTENSIONS = new Set([
    'c', 'cc', 'cpp', 'css', 'go', 'h', 'html', 'java', 'js', 'jsx', 'mjs', 'py',
    'rb', 'rs', 'scss', 'sh', 'sql', 'svelte', 'swift', 'ts', 'tsx', 'vue',
]);
const TEXT_EXTENSIONS = new Set(['md', 'mdx', 'txt', 'log', 'csv', 'xml', 'yaml', 'yml']);

function fileIcon(name: string): typeof File {
    const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : '';
    if (extension === 'json') return FileJson;
    if (CODE_EXTENSIONS.has(extension)) return FileCode;
    if (TEXT_EXTENSIONS.has(extension)) return FileText;
    return File;
}

function parseEntries(payload: unknown, parentPath: string): FileEntry[] {
    const candidate = Array.isArray(payload)
        ? payload
        : payload && typeof payload === 'object'
            ? (payload as { entries?: unknown; files?: unknown }).entries
                ?? (payload as { files?: unknown }).files
            : null;
    if (!Array.isArray(candidate)) return [];

    return candidate.flatMap((item): FileEntry[] => {
        if (!item || typeof item !== 'object') return [];
        const row = item as Record<string, unknown>;
        if (typeof row['name'] !== 'string') return [];
        const path = typeof row['path'] === 'string'
            ? row['path']
            : parentPath === '.' ? row['name'] : `${parentPath}/${row['name']}`;
        const isDirectory = row['isDirectory'] === true
            || row['directory'] === true
            || row['kind'] === 'directory'
            || row['type'] === 'directory'
            || row['type'] === 'dir';
        return [{ name: row['name'], path, isDirectory }];
    }).sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
}

function flattenTree(
    path: string,
    depth: number,
    directories: Map<string, DirectoryState>,
    expanded: Set<string>,
): TreeNode[] {
    const state = directories.get(path);
    if (state?.status !== 'loaded') return [];

    return state.entries.flatMap((entry) => {
        const node = { ...entry, depth };
        return entry.isDirectory && expanded.has(entry.path)
            ? [node, ...flattenTree(entry.path, depth + 1, directories, expanded)]
            : [node];
    });
}

export function FileTreePanel(): JSX.Element {
    const bridge = useDesktopBridge();
    const { selected } = useAppScope();
    const port = selected?.port ?? null;
    const nativeFolder = bridge.filesystem.folder.nativeAvailable
        ? bridge.filesystem.folder.native
        : null;
    const currentPortRef = useRef(port);
    currentPortRef.current = port;
    const mountedRef = useRef(true);
    const scrollerRef = useRef<HTMLDivElement>(null);
    const [directories, setDirectories] = useState<Map<string, DirectoryState>>(new Map());
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [isUnavailable, setIsUnavailable] = useState(false);

    const loadDirectory = useCallback(async (path: string): Promise<void> => {
        if (port === null) return;
        const requestPort = port;
        setDirectories((current) => new Map(current).set(path, { status: 'loading' }));
        try {
            if (nativeFolder) {
                const result = await nativeFolder.listDir(path);
                if (currentPortRef.current !== requestPort || !mountedRef.current) return;
                if (!result.ok) throw new Error(result.error ?? 'Unable to load files');
                const entries = parseEntries(result.entries ?? [], path);
                setDirectories((current) => new Map(current).set(path, { status: 'loaded', entries }));
                return;
            }
            const response = await fetch(`/i/${requestPort}/api/files?path=${encodeURIComponent(path)}`);
            if (currentPortRef.current !== requestPort || !mountedRef.current) return;
            if (response.status === 404) {
                setIsUnavailable(true);
                return;
            }
            if (!response.ok) throw new Error(`Unable to load files (${response.status})`);
            const entries = parseEntries(await response.json() as unknown, path);
            if (currentPortRef.current !== requestPort || !mountedRef.current) return;
            setDirectories((current) => new Map(current).set(path, { status: 'loaded', entries }));
        } catch (error) {
            if (currentPortRef.current !== requestPort || !mountedRef.current) return;
            const message = error instanceof Error ? error.message : 'Unable to load files';
            setDirectories((current) => new Map(current).set(path, { status: 'error', message }));
        }
    }, [nativeFolder, port]);

    useEffect(() => {
        mountedRef.current = true;
        setDirectories(new Map());
        setExpanded(new Set());
        setIsUnavailable(false);
        if (port !== null) void loadDirectory('.');
        return () => { mountedRef.current = false; };
    }, [loadDirectory, port]);

    const rows = useMemo(
        () => flattenTree('.', 0, directories, expanded),
        [directories, expanded],
    );
    const virtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => scrollerRef.current,
        estimateSize: () => 28,
        overscan: 8,
    });

    const toggleDirectory = (entry: FileEntry): void => {
        const isOpen = expanded.has(entry.path);
        setExpanded((current) => {
            const next = new Set(current);
            if (isOpen) next.delete(entry.path);
            else next.add(entry.path);
            return next;
        });
        if (!isOpen && !directories.has(entry.path)) void loadDirectory(entry.path);
    };

    const rootState = directories.get('.');
    if (port === null) {
        return <div className="d2-file-tree d2-file-tree-message">Select an instance to browse files</div>;
    }
    if (isUnavailable) {
        return <div className="d2-file-tree d2-file-tree-message">File browser coming soon</div>;
    }
    if (rootState?.status === 'loading' || !rootState) {
        return (
            <div className="d2-file-tree d2-file-tree-message" role="status">
                <Icon icon={LoaderCircle} size={16} />
                <span>Loading files</span>
            </div>
        );
    }
    if (rootState.status === 'error') {
        return <div className="d2-file-tree d2-file-tree-message">{rootState.message}</div>;
    }
    if (rows.length === 0) {
        return <div className="d2-file-tree d2-file-tree-message">No files found</div>;
    }

    return (
        <div ref={scrollerRef} className="d2-file-tree" role="tree" aria-label="Files">
            <div className="d2-file-tree-virtual" style={{ height: virtualizer.getTotalSize() }}>
                {virtualizer.getVirtualItems().map((virtualRow) => {
                    const entry = rows[virtualRow.index];
                    if (!entry) return null;
                    const isOpen = entry.isDirectory && expanded.has(entry.path);
                    const state = entry.isDirectory ? directories.get(entry.path) : null;
                    const isLoading = state?.status === 'loading';
                    const icon = entry.isDirectory ? (isOpen ? FolderOpen : Folder) : fileIcon(entry.name);
                    return (
                        <button
                            key={entry.path}
                            className={`d2-file-node${isLoading ? ' is-loading' : ''}`}
                            type="button"
                            role="treeitem"
                            aria-expanded={entry.isDirectory ? isOpen : undefined}
                            title={entry.path}
                            onClick={() => entry.isDirectory && toggleDirectory(entry)}
                            style={{
                                paddingLeft: 8 + entry.depth * 16,
                                transform: `translateY(${virtualRow.start}px)`,
                            }}
                        >
                            <span className="d2-file-node-toggle">
                                {entry.isDirectory
                                    ? <Icon icon={isOpen ? ChevronDown : ChevronRight} size={13} />
                                    : null}
                            </span>
                            <Icon icon={isLoading ? LoaderCircle : icon} size={15} />
                            <span className="d2-file-node-name">{entry.name}</span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
