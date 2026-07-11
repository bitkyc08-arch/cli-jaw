export interface DesktopIdentityEnvelope {
    name: 'cli-jaw-desktop';
    electron: true;
    header: 'X-CLI-Jaw-Electron';
    token: string;
}

export interface TerminalSessionSnapshot {
    id: string;
    shell: string;
    cwd: string;
    cols: number;
    rows: number;
    buffer: string;
}

export interface TerminalBridgeApi {
    list(): Promise<{ ok: boolean; sessions?: TerminalSessionSnapshot[]; error?: string }>;
    create(opts?: { cwd?: string; cols?: number; rows?: number }): Promise<{
        ok: boolean;
        id?: string;
        shell?: string;
        cwd?: string;
        error?: string;
    }>;
    write(id: string, data: string): Promise<void>;
    resize(id: string, cols: number, rows: number): Promise<void>;
    kill(id: string): Promise<void>;
    onData(callback: (id: string, data: string) => void): () => void;
    onExit(callback: (id: string, code: number | null) => void): () => void;
}

export type DiffMode = 'unstaged' | 'staged' | 'head' | 'base';

export interface DiffOptions {
    mode: DiffMode;
    ref?: string;
    includeUntracked?: boolean;
}

export interface DiffRootCandidate {
    path: string;
    label: string;
    source: 'project' | 'working-dir' | 'pinned' | 'recent' | 'home';
}

export interface DiffResolvedRoot extends DiffRootCandidate {
    root: string;
    branch: string | null;
    head: string | null;
    dirty: boolean;
}

export interface SourceControlFile {
    path: string;
    repoRelativePath: string;
    kind: string;
    staged: boolean;
    unstaged: boolean;
    conflict: boolean;
}

export interface SourceControlGroup {
    id: 'conflicts' | 'staged' | 'changes' | 'untracked';
    label: string;
    files: SourceControlFile[];
}

export interface SourceControlSnapshot {
    repoRoot: string;
    branch: string | null;
    head: string | null;
    dirty: boolean;
    groups: SourceControlGroup[];
}

export interface SourceControlOperation {
    kind: 'stage' | 'unstage';
    paths: string[];
}

export interface SourceControlOperationResult {
    operation: SourceControlOperation['kind'];
    paths: string[];
    snapshot: SourceControlSnapshot;
}

export interface DiffBridgeApi {
    getRepoRoot(cwd: string): Promise<{ ok: boolean; root?: string; error?: string }>;
    getRepoCandidates(candidates: DiffRootCandidate[]): Promise<{
        ok: boolean;
        candidates?: DiffResolvedRoot[];
        error?: string;
    }>;
    getScmSnapshot(repoRoot: string, options?: { includeUntracked?: boolean }): Promise<{
        ok: boolean;
        snapshot?: SourceControlSnapshot;
        error?: string;
    }>;
    runScmOperation(repoRoot: string, operation: SourceControlOperation): Promise<{
        ok: boolean;
        result?: SourceControlOperationResult;
        error?: string;
    }>;
    getDiffSummary(repoRoot: string, options: DiffOptions): Promise<{
        ok: boolean;
        files?: Array<{ path: string; status: string; insertions: number; deletions: number }>;
        error?: string;
    }>;
    getFileDiff(repoRoot: string, filePath: string, options: DiffOptions): Promise<{
        ok: boolean;
        diff?: string;
        error?: string;
    }>;
}

export interface GitWorktreeEntry {
    path: string;
    head: string | null;
    branch: string | null;
    bare: boolean;
    detached: boolean;
    prunable: boolean;
    locked: boolean;
    reason: string | null;
    current: boolean;
}

export type GitWorktreeOperation =
    | { type: 'worktree-add'; path: string; branch: string; createBranch: boolean }
    | { type: 'worktree-remove'; path: string; force: boolean }
    | { type: 'worktree-prune' };

export interface GitWorktreeOperationPreview {
    command: string[];
    label: string;
    destructive: boolean;
    requiresConfirmation: true;
}

export type GitFileDecorationKind =
    | 'modified'
    | 'added'
    | 'deleted'
    | 'renamed'
    | 'untracked'
    | 'ignored'
    | 'conflict'
    | 'submodule';

export interface GitStatusMapResult {
    repoRoot: string;
    branch: string | null;
    head: string | null;
    dirty: boolean;
    files: Array<{
        path: string;
        repoRelativePath: string;
        kind: GitFileDecorationKind;
        staged: boolean;
        unstaged: boolean;
        ignored: boolean;
        conflict: boolean;
        submodule: boolean;
    }>;
    directories: Array<{
        path: string;
        repoRelativePath: string;
        kinds: GitFileDecorationKind[];
        changedCount: number;
    }>;
}

export interface GitBridgeApi {
    getStatusMap(
        folderPanelRoot: string,
        repoRoot?: string,
        options?: { includeIgnored?: boolean; includeUntracked?: boolean },
    ): Promise<{ ok: boolean; status?: GitStatusMapResult; error?: string }>;
    getWorktrees(folderPanelRoot: string, repoRoot?: string): Promise<{
        ok: boolean;
        repoRoot?: string;
        worktrees?: GitWorktreeEntry[];
        error?: string;
    }>;
    previewWorktreeOperation(
        folderPanelRoot: string,
        repoRoot: string | undefined,
        operation: GitWorktreeOperation,
    ): Promise<{ ok: boolean; preview?: GitWorktreeOperationPreview; error?: string }>;
    runWorktreeOperation(
        folderPanelRoot: string,
        repoRoot: string | undefined,
        operation: GitWorktreeOperation,
        confirmed: boolean,
    ): Promise<{
        ok: boolean;
        repoRoot?: string;
        preview?: GitWorktreeOperationPreview;
        stdout?: string;
        worktrees?: GitWorktreeEntry[];
        error?: string;
    }>;
}

export interface FolderEntry {
    name: string;
    path: string;
    kind: 'file' | 'directory';
    size: number;
}

export interface FolderMutationResult {
    ok: boolean;
    entry?: FolderEntry;
    error?: string;
    code?: string;
}

export interface FolderBridgeApi {
    getDefaultRoot(): Promise<{ ok: boolean; path?: string; error?: string }>;
    pickFolder(): Promise<{ ok: boolean; path?: string; error?: string }>;
    pickFile(): Promise<{ ok: boolean; path?: string; error?: string }>;
    authorizeRoot(rootPath: string): Promise<{ ok: boolean; path?: string; error?: string }>;
    registerGitWorktreeRoot(
        folderPanelRoot: string,
        repoRoot: string | undefined,
        worktreePath: string,
    ): Promise<{ ok: boolean; path?: string; error?: string }>;
    listDir(dirPath: string, depth?: number): Promise<{ ok: boolean; entries?: FolderEntry[]; error?: string }>;
    readFile(filePath: string): Promise<{
        ok: boolean;
        content?: string;
        truncated?: boolean;
        binary?: boolean;
        error?: string;
    }>;
    movePath(sourcePath: string, targetDirectory: string): Promise<{
        ok: boolean;
        moved?: { from: string; to: string; name: string; kind: 'file' | 'directory' };
        error?: string;
        code?: string;
    }>;
    createFile(parentDirectory: string, name: string): Promise<FolderMutationResult>;
    createFolder(parentDirectory: string, name: string): Promise<FolderMutationResult>;
    renamePath(sourcePath: string, name: string): Promise<FolderMutationResult>;
    revealPath(path: string): Promise<{ ok: boolean; error?: string }>;
    watchDir(dirPath: string): Promise<{ ok: boolean; error?: string }>;
    unwatchDir(dirPath: string): Promise<{ ok: boolean; error?: string }>;
    onDirChange(callback: (dirPath: string) => void): () => void;
}

export interface DragDropBridgeApi {
    resolveDroppedItems(files: File[]): Promise<{
        ok: boolean;
        entries?: Array<{ name: string; path: string; kind: 'file' | 'directory' }>;
        rejected?: Array<{ path: string; reason: string }>;
        error?: string;
    }>;
}

export interface ClipboardBridgeApi {
    writeText(text: string): Promise<{ ok: boolean; error?: string }>;
}

export interface PermissionDiagnosticsBridgeApi {
    getLastDenials(): Promise<{
        ok: boolean;
        denials?: Array<{
            at: string;
            surface: 'manager-window' | 'preview-frame' | 'embedded-browser-webview';
            permission: string;
            requestingUrl: string;
            reason: string;
        }>;
        error?: string;
    }>;
}

export interface ShortcutsBridgeApi {
    onAction(callback: (action: string) => void): () => void;
}

export interface TrayBridgeApi {
    popUpMenu(): void;
    openDashboard(): void;
}

export interface BrowserWebviewTabState {
    tabId: string;
    webContentsId: number;
    url: string;
    title: string;
    loading: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
    devToolsOpen?: boolean;
    devToolsTargetId?: string;
    sharedWithAgent?: boolean;
    actionsEnabled?: boolean;
    inspecting?: boolean;
    crashed?: boolean;
    error?: string;
}

export type BrowserWebviewCommand =
    | { kind: 'navigate'; tabId: string; url: string }
    | { kind: 'reload'; tabId: string; ignoreCache?: boolean }
    | { kind: 'goBack'; tabId: string }
    | { kind: 'goForward'; tabId: string }
    | { kind: 'stop'; tabId: string };

export interface BrowserPickedElement {
    selector: string;
    tagName: string;
    role: string | null;
    name: string | null;
    text: string | null;
    bounds: { x: number; y: number; width: number; height: number } | null;
}

export interface BrowserDomSnapshotNode {
    tag: string;
    role: string | null;
    name: string | null;
    text: string | null;
    selector: string;
    bounds: { x: number; y: number; width: number; height: number } | null;
}

export type BrowserActPayload =
    | { kind: 'click'; x: number; y: number }
    | { kind: 'type'; text: string }
    | { kind: 'scroll'; x: number; y: number; deltaY: number }
    | { kind: 'key'; key: string };

export type BrowserWebviewNativeAction =
    | { kind: 'openExternal'; tabId: string }
    | { kind: 'openDevTools'; tabId: string; mode?: 'right' | 'bottom' | 'detach' }
    | { kind: 'closeDevTools'; tabId: string }
    | { kind: 'captureScreenshot'; tabId: string }
    | { kind: 'inspectElement'; tabId: string; x: number; y: number }
    | { kind: 'setSharedWithAgent'; tabId: string; shared: boolean }
    | { kind: 'startInspect'; tabId: string }
    | { kind: 'stopInspect'; tabId: string }
    | { kind: 'getDomSnapshot'; tabId: string }
    | { kind: 'setActionsEnabled'; tabId: string; enabled: boolean }
    | { kind: 'act'; tabId: string; act: BrowserActPayload };

export interface BrowserWebviewScreenshot {
    tabId: string;
    url: string;
    title: string;
    capturedAt: string;
    width: number;
    height: number;
    dataUrl: string;
}

export interface BrowserBridgeApi {
    onOpenUrl(callback: (payload: { url: string; disposition: 'current-tab' | 'new-tab' }) => void): () => void;
    registerWebview(input: { tabId: string; webContentsId: number }): Promise<{
        ok: boolean;
        state?: BrowserWebviewTabState;
        error?: string;
    }>;
    unregisterWebview(input: { tabId: string; webContentsId?: number }): Promise<
        | { ok: true; stale?: true }
        | { ok: false; error: string }
    >;
    controlWebview(command: BrowserWebviewCommand): Promise<{
        ok: boolean;
        state?: BrowserWebviewTabState;
        error?: string;
    }>;
    performWebviewAction(action: BrowserWebviewNativeAction): Promise<{
        ok: boolean;
        state?: BrowserWebviewTabState;
        screenshot?: BrowserWebviewScreenshot;
        snapshot?: BrowserDomSnapshotNode[];
        error?: string;
    }>;
    getWebviewTabs(): Promise<{ ok: boolean; tabs?: BrowserWebviewTabState[]; error?: string }>;
    onWebviewState(callback: (state: BrowserWebviewTabState) => void): () => void;
    onElementPicked(callback: (payload: { tabId: string; element: BrowserPickedElement }) => void): () => void;
}

/** Raw API exposed by electron/src/preload/index.ts. Groups stay optional for old shells. */
export interface DesktopPreloadApi {
    identify?: () => DesktopIdentityEnvelope;
    getMetrics?: () => unknown;
    getHomePath?: () => string;
    terminal?: TerminalBridgeApi;
    diff?: DiffBridgeApi;
    git?: GitBridgeApi;
    folder?: FolderBridgeApi;
    dragDrop?: DragDropBridgeApi;
    clipboard?: ClipboardBridgeApi;
    permissions?: PermissionDiagnosticsBridgeApi;
    shortcuts?: ShortcutsBridgeApi;
    trayReminders?: TrayBridgeApi;
    browser?: BrowserBridgeApi;
    reloadWindow?: () => Promise<void>;
    hardReloadWindow?: () => Promise<void>;
}
