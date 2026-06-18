import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { getDesktop, type DiffBridgeApi, type DiffOptions, type DiffResolvedRoot, type DiffRootCandidate } from '../panels/desktop-bridge';
import type { DashboardDiffMode, DashboardInstance, DashboardRegistryUi } from '../types';
import { createDashboardGitDiffClient } from './diff-client';
import { buildDiffRootCandidates } from './diff-root-candidates';
import './diff-panel.css';

type DiffFileSummary = {
    path: string;
    status: string;
    insertions: number;
    deletions: number;
};

type DiffSettings = Pick<DashboardRegistryUi,
    'diffRootPolicy' | 'diffPinnedRootByPort' | 'diffRecentRepoRoots' | 'diffDefaultMode' | 'diffBaseRef' | 'diffIncludeUntracked'
>;

type DiffPanelProps = {
    selectedInstance: DashboardInstance | null;
    settings: DiffSettings;
    folderRootPath?: string | null;
    repoRootPath?: string | null;
    selectedFilePath?: string | null;
    onRepoRootChange?: (path: string | null) => void;
    onPreviewFile?: (path: string) => void;
    onSettingsPatch?: (patch: Partial<DashboardRegistryUi>) => void;
};

const DIFF_MODES: DashboardDiffMode[] = ['unstaged', 'staged', 'head', 'base'];
const RECENT_REPO_LIMIT = 8;

function getDiffLineClass(line: string): string {
    if (line.startsWith('@@')) return 'diff-line-hunk';
    if (line.startsWith('diff ') || line.startsWith('index ')) return 'diff-line-meta';
    if (line.startsWith('--- ') || line.startsWith('+++ ')) return 'diff-line-meta';
    if (line.startsWith('+')) return 'diff-line-add';
    if (line.startsWith('-')) return 'diff-line-del';
    return '';
}

function renderDiffLines(text: string): ReactNode {
    if (!text) return null;
    return text.split('\n').map((line, i) => {
        const cls = getDiffLineClass(line);
        return <span key={i} className={`diff-line${cls ? ` ${cls}` : ''}`}>{line}{'\n'}</span>;
    });
}

function getDiffBridge(): DiffBridgeApi | null {
    return getDesktop()?.diff ?? null;
}

function diffOptions(settings: DiffSettings): DiffOptions {
    const options: DiffOptions = {
        mode: settings.diffDefaultMode,
        includeUntracked: settings.diffIncludeUntracked,
    };
    if (settings.diffDefaultMode === 'base') options.ref = settings.diffBaseRef.trim() || 'HEAD';
    return options;
}

function rootTitle(root: DiffResolvedRoot): string {
    const suffix = root.branch ?? root.head ?? 'detached';
    return `${root.label}: ${root.root} (${suffix}${root.dirty ? ', dirty' : ''})`;
}

function recentRepoRoots(current: string[], root: string): string[] {
    const next = [root, ...current.filter(item => item !== root)];
    return next.slice(0, RECENT_REPO_LIMIT);
}

function pickedRepoCandidate(path: string): DiffRootCandidate {
    return { path, label: 'Picked repo', source: 'recent' };
}

function folderRepoCandidate(path: string): DiffRootCandidate {
    return { path, label: 'Folder root', source: 'recent' };
}

function normalizePath(path: string): string {
    return path.replace(/\/+$/, '');
}

function isPathInsideRoot(path: string, root: string): boolean {
    const normalizedPath = normalizePath(path);
    const normalizedRoot = normalizePath(root);
    return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function absoluteDiffPath(repoRoot: string | null, filePath: string | null): string | null {
    if (!repoRoot || !filePath) return null;
    if (filePath.startsWith('/')) return filePath;
    return `${normalizePath(repoRoot)}/${filePath.replace(/^\/+/, '')}`;
}

function relativeDiffPath(repoRoot: string | null, filePath: string | null): string | null {
    if (!repoRoot || !filePath || !filePath.startsWith('/')) return null;
    const normalizedRoot = normalizePath(repoRoot);
    const normalizedFile = normalizePath(filePath);
    if (normalizedFile === normalizedRoot) return null;
    if (!normalizedFile.startsWith(`${normalizedRoot}/`)) return null;
    return normalizedFile.slice(normalizedRoot.length + 1);
}

export function DiffPanel(props: DiffPanelProps) {
    const repoRootPath = props.repoRootPath ?? null;
    const folderRootPath = props.folderRootPath ?? null;
    const onRepoRootChange = props.onRepoRootChange;
    const desktopBridge = getDiffBridge();
    const bridge = useMemo(
        () => desktopBridge ?? createDashboardGitDiffClient(props.selectedInstance, props.settings),
        [desktopBridge, props.selectedInstance, props.settings],
    );
    const [repoCandidates, setRepoCandidates] = useState<DiffResolvedRoot[]>([]);
    const [repoRoot, setRepoRoot] = useState<string | null>(null);
    const [files, setFiles] = useState<DiffFileSummary[]>([]);
    const [selectedFile, setSelectedFile] = useState<string | null>(null);
    const [diffContent, setDiffContent] = useState<string>('');
    const [error, setError] = useState<string | null>(null);
    const [pickingRepo, setPickingRepo] = useState(false);
    const selectedInstanceKey = `${props.selectedInstance?.port ?? 'none'}:${props.selectedInstance?.workingDir ?? ''}:${props.selectedInstance?.projectDirs?.join('\0') ?? ''}`;
    const options = useMemo(() => diffOptions(props.settings), [
        props.settings.diffDefaultMode,
        props.settings.diffBaseRef,
        props.settings.diffIncludeUntracked,
    ]);
    const selectedRoot = repoCandidates.find(candidate => candidate.root === repoRoot) ?? null;

    const loadRepoCandidates = useCallback(async () => {
        if (!bridge) return;
        const desktop = getDesktop();
        const home = desktop?.getHomePath?.() || '/tmp';
        const candidates = buildDiffRootCandidates(props.selectedInstance, home, {
            diffRootPolicy: props.settings.diffRootPolicy,
            diffPinnedRootByPort: props.settings.diffPinnedRootByPort,
            diffRecentRepoRoots: props.settings.diffRecentRepoRoots,
        });
        if (folderRootPath) candidates.unshift(folderRepoCandidate(folderRootPath));
        const result = await bridge.getRepoCandidates(candidates);
        if (!result.ok) {
            setError(result.error ?? 'Failed to resolve git repositories');
            return;
        }
        const roots = result.candidates ?? [];
        setRepoCandidates(roots);
        setRepoRoot(current => {
            const requestedRoot = repoRootPath && roots.some(root => root.root === repoRootPath)
                ? repoRootPath
                : null;
            const folderRoot = folderRootPath
                ? roots.find(root => isPathInsideRoot(folderRootPath, root.root))?.root ?? null
                : null;
            const nextRoot = folderRoot ?? requestedRoot ?? (current && roots.some(root => root.root === current) ? current : null) ?? roots[0]?.root ?? null;
            if (nextRoot !== repoRootPath) onRepoRootChange?.(nextRoot);
            return nextRoot;
        });
        if (roots.length === 0) {
            onRepoRootChange?.(null);
            setError('No git repository found from the selected instance roots.');
        }
        else setError(null);
    }, [
        bridge,
        selectedInstanceKey,
        folderRootPath,
        onRepoRootChange,
        props.selectedInstance,
        props.settings.diffRootPolicy,
        props.settings.diffPinnedRootByPort,
        props.settings.diffRecentRepoRoots,
        repoRootPath,
    ]);

    useEffect(() => {
        if (repoRootPath === repoRoot) return;
        if (repoRootPath && repoCandidates.some(root => root.root === repoRootPath)) {
            setRepoRoot(repoRootPath);
            return;
        }
        if (repoRootPath === null) setRepoRoot(null);
    }, [repoRootPath, repoCandidates, repoRoot]);

    const loadSummary = useCallback(async () => {
        if (!bridge || !repoRoot) return;
        const result = await bridge.getDiffSummary(repoRoot, options);
        if (result.ok && result.files) {
            setFiles(result.files);
            setSelectedFile(current => current && result.files?.some(file => file.path === current) ? current : result.files?.[0]?.path ?? null);
            setError(null);
        } else {
            setFiles([]);
            setSelectedFile(null);
            setError(result.error ?? 'Failed to get diff summary');
        }
    }, [bridge, options, repoRoot]);

    useEffect(() => { void loadRepoCandidates(); }, [loadRepoCandidates]);
    useEffect(() => { void loadSummary(); }, [loadSummary]);

    useEffect(() => {
        const nextSelected = relativeDiffPath(repoRoot, props.selectedFilePath ?? null);
        if (!nextSelected || nextSelected === selectedFile) return;
        if (files.some(file => file.path === nextSelected)) setSelectedFile(nextSelected);
    }, [files, repoRoot, props.selectedFilePath, selectedFile]);

    useEffect(() => {
        if (!bridge || !repoRoot || !selectedFile) {
            setDiffContent('');
            return;
        }
        void (async () => {
            const result = await bridge.getFileDiff(repoRoot, selectedFile, options);
            if (result.ok && result.diff !== undefined) setDiffContent(result.diff || 'No textual diff for this file.');
            else setDiffContent(`Error: ${result.error ?? 'unknown'}`);
        })();
    }, [bridge, options, repoRoot, selectedFile]);

    function handleRootChange(root: string, nextRecentRepoRoots?: string[]): void {
        setRepoRoot(root);
        setSelectedFile(null);
        onRepoRootChange?.(root);
        const port = props.selectedInstance?.port;
        const patch: Partial<DashboardRegistryUi> = {};
        if (port != null) {
            patch.diffPinnedRootByPort = {
                ...props.settings.diffPinnedRootByPort,
                [String(port)]: root,
            };
        }
        if (nextRecentRepoRoots) patch.diffRecentRepoRoots = nextRecentRepoRoots;
        if (Object.keys(patch).length > 0) props.onSettingsPatch?.(patch);
    }

    function handleFileSelect(path: string): void {
        setSelectedFile(path);
        const absolutePath = absoluteDiffPath(repoRoot, path);
        if (absolutePath) props.onPreviewFile?.(absolutePath);
    }

    function handleModeChange(mode: DashboardDiffMode): void {
        props.onSettingsPatch?.({ diffDefaultMode: mode });
    }

    async function handleChooseRepository(): Promise<void> {
        const folderBridge = getDesktop()?.folder;
        if (!folderBridge?.pickFolder) {
            setError('Choose Repository is available in the Electron app.');
            return;
        }
        if (!bridge) {
            setError('Diff bridge is unavailable.');
            return;
        }
        setPickingRepo(true);
        try {
            const picked = await folderBridge.pickFolder();
            if (!picked.ok || !picked.path) {
                if (picked.error && picked.error !== 'cancelled') setError(picked.error);
                return;
            }
            const result = await bridge.getRepoCandidates([pickedRepoCandidate(picked.path)]);
            if (!result.ok) {
                setError(result.error ?? 'Failed to validate selected repository');
                return;
            }
            const resolved = result.candidates?.[0] ?? null;
            if (!resolved) {
                setError('Selected folder is not a git repository.');
                return;
            }
            const nextRecentRepoRoots = recentRepoRoots(props.settings.diffRecentRepoRoots, resolved.root);
            setRepoCandidates(current => current.some(candidate => candidate.root === resolved.root)
                ? current.map(candidate => candidate.root === resolved.root ? resolved : candidate)
                : [resolved, ...current]);
            setError(null);
            handleRootChange(resolved.root, nextRecentRepoRoots);
        } finally {
            setPickingRepo(false);
        }
    }

    return (
        <div className="diff-panel">
            <div className="diff-toolbar">
                <select
                    className="diff-root-select"
                    value={repoRoot ?? ''}
                    aria-label="Git repository root"
                    onChange={(event) => handleRootChange(event.currentTarget.value)}
                >
                    {repoCandidates.map(candidate => (
                        <option key={candidate.root} value={candidate.root}>{rootTitle(candidate)}</option>
                    ))}
                    {repoCandidates.length === 0 && <option value="">No repo</option>}
                </select>
                <span className="diff-head-chip">{selectedRoot?.branch ?? selectedRoot?.head ?? 'no repo'}</span>
                <button type="button" className="diff-pick-repo" onClick={() => void handleChooseRepository()} disabled={pickingRepo}>
                    {pickingRepo ? 'Choosing...' : 'Choose Repository'}
                </button>
                <button type="button" className="diff-refresh" onClick={() => void loadRepoCandidates()}>Refresh</button>
            </div>
            <div className="diff-toolbar diff-options">
                <div className="diff-mode-group" aria-label="Diff mode">
                    {DIFF_MODES.map(mode => (
                        <button
                            key={mode}
                            type="button"
                            className={`diff-mode-button${props.settings.diffDefaultMode === mode ? ' is-active' : ''}`}
                            aria-pressed={props.settings.diffDefaultMode === mode}
                            onClick={() => handleModeChange(mode)}
                        >
                            {mode === 'head' ? 'HEAD' : mode === 'base' ? 'Base' : mode}
                        </button>
                    ))}
                </div>
                <input
                    className="diff-ref-input"
                    type="text"
                    value={props.settings.diffBaseRef}
                    aria-label="Base ref"
                    disabled={props.settings.diffDefaultMode !== 'base'}
                    onChange={(event) => props.onSettingsPatch?.({ diffBaseRef: event.currentTarget.value })}
                />
                <label className="diff-untracked-toggle">
                    <input
                        type="checkbox"
                        checked={props.settings.diffIncludeUntracked}
                        onChange={(event) => props.onSettingsPatch?.({ diffIncludeUntracked: event.currentTarget.checked })}
                    />
                    <span>untracked</span>
                </label>
            </div>
            {error && <div className="diff-error">{error}</div>}
            <div className="diff-body">
                <div className="diff-file-list">
                    {files.map(f => (
                        <button key={f.path} type="button"
                            className={`diff-file-item ${f.path === selectedFile ? 'is-selected' : ''} diff-status-${f.status}`}
                            onClick={() => handleFileSelect(f.path)}>
                            <span className="diff-file-name">{f.path}</span>
                            <span className="diff-file-stats">
                                {f.insertions > 0 && <span className="diff-ins">+{f.insertions}</span>}
                                {f.deletions > 0 && <span className="diff-del">-{f.deletions}</span>}
                                {f.status === 'untracked' && <span className="diff-ins">new</span>}
                            </span>
                        </button>
                    ))}
                    {files.length === 0 && !error && <div className="diff-empty">No changes</div>}
                </div>
                <div className="diff-content">
                    <pre className="diff-pre">{renderDiffLines(diffContent)}</pre>
                </div>
            </div>
        </div>
    );
}
