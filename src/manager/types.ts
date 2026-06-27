import type { TelegramHubConfig } from './telegram-hub/types.js';

export type DashboardInstanceStatus =
    | 'online'
    | 'offline'
    | 'timeout'
    | 'error'
    | 'unknown';

export type DashboardServiceMode = 'unknown' | 'ad-hoc' | 'service' | 'manager';
export type DashboardPreviewMode = 'direct' | 'proxy';
export type DashboardLifecycleAction = 'start' | 'stop' | 'restart' | 'perm' | 'unperm';
export type DashboardLifecycleOwner = 'none' | 'external' | 'manager' | 'service' | 'peer';
export type DashboardDetailTab = 'overview' | 'preview' | 'logs' | 'settings';
export type DashboardUiTheme = 'auto' | 'dark' | 'light';
export type DashboardLocale = 'ko' | 'en' | 'zh' | 'ja';
export type DashboardSidebarMode =
    | 'instances'
    | 'board'
    | 'schedule'
    | 'notes'
    | 'reminders'
    | 'settings';
export type DashboardShortcutAction =
    | 'focusInstances'
    | 'focusActiveSession'
    | 'focusNotes'
    | 'previousInstance'
    | 'nextInstance';
export type DashboardShortcutKeymap = Record<DashboardShortcutAction, string>;
export type DashboardDiffMode = 'unstaged' | 'staged' | 'head' | 'base';
export type DashboardDiffRootPolicy = 'project-first' | 'working-dir-first' | 'manual';
export type DashboardNotesViewMode = 'raw' | 'split' | 'preview' | 'settings' | 'graph';
export type DashboardNotesAuthoringMode = 'plain' | 'rich' | 'wysiwyg';

export type DashboardNotesGraphSection = 'filters' | 'display' | 'forces' | 'groups';

export type DashboardNotesGraphGroup = {
    id: string;
    label: string;
    query: string;
    color: string;
    enabled: boolean;
};

export type DashboardNotesGraphSettings = {
    version: 1;
    panelOpen: boolean;
    collapsedSections: Partial<Record<DashboardNotesGraphSection, boolean>>;
    query: string;
    existingFilesOnly: boolean;
    showOrphans: boolean;
    showTags: boolean;
    showAttachments: boolean;
    focusSelected: boolean;
    focusDepth: number;
    groupMode: 'off' | 'query';
    groups: DashboardNotesGraphGroup[];
    nodeSize: number;
    linkDistance: number;
    chargeStrength: number;
    labelDensity: number;
    showArrows: boolean;
    animate: boolean;
};
export type DashboardProfileId = string;

export type DashboardProxyInfo = {
    enabled: boolean;
    basePath: string;
    allowedFrom: number;
    allowedTo: number;
    preview?: DashboardOriginPreviewProxyInfo;
};

export type DashboardPreviewProxyStatus = 'ready' | 'unavailable';

export type DashboardPreviewProxyInstance = {
    targetPort: number;
    previewPort: number;
    url: string;
    status: DashboardPreviewProxyStatus;
    reason: string | null;
};

export type DashboardOriginPreviewProxyInfo = {
    enabled: boolean;
    kind: 'origin-port';
    previewFrom: number;
    previewTo: number;
    instances: Record<string, DashboardPreviewProxyInstance>;
};

export type DashboardInstance = {
    port: number;
    url: string;
    status: DashboardInstanceStatus;
    ok: boolean;
    version: string | null;
    uptime: number | null;
    instanceId: string | null;
    homeDisplay: string | null;
    workingDir: string | null;
    projectDirs: string[] | null;
    currentCli: string | null;
    currentModel: string | null;
    serviceMode: DashboardServiceMode;
    profileId?: DashboardProfileId | null;
    label?: string | null;
    favorite?: boolean;
    group?: string | null;
    hidden?: boolean;
    lifecycle?: DashboardLifecycleCapability;
    lastCheckedAt: string;
    healthReason: string | null;
};

export type DashboardProfile = {
    profileId: DashboardProfileId;
    label: string;
    homePath: string;
    preferredPort: number | null;
    serviceMode: DashboardServiceMode;
    defaultCli: string | null;
    notes: string | null;
    lastSeenAt: string | null;
    pinned: boolean;
    color: string | null;
};

export type DashboardLifecycleCapability = {
    owner: DashboardLifecycleOwner;
    canStart: boolean;
    canStop: boolean;
    canRestart: boolean;
    canPerm: boolean;
    canUnperm: boolean;
    reason: string;
    defaultHome: string;
    commandPreview: string[];
    pid: number | null;
};

export type DashboardServiceState = {
    registered: boolean;
    loaded: boolean;
    pid: number | null;
    label: string;
    unitPath: string;
    backend: 'launchd' | 'systemd' | 'none';
};

export type DashboardLifecycleExpectedState = 'online' | 'offline' | 'restart-detected';

export type DashboardLifecycleResult = {
    ok: boolean;
    action: DashboardLifecycleAction;
    port: number;
    status: 'started' | 'stopped' | 'restarted' | 'permed' | 'unpermed' | 'rejected' | 'error' | 'skipped';
    message: string;
    home: string | null;
    pid: number | null;
    command: string[];
    expectedStateAfter?: DashboardLifecycleExpectedState;
    stderr?: string;
    stdout?: string;
};

export type DashboardProcessProof = 'child' | 'registry';

export type DashboardProcessControlEntry = {
    port: number;
    pid: number | null;
    home: string | null;
    proof: DashboardProcessProof;
    canStop: boolean;
    canForceRelease: boolean;
    reason: string;
};

export type DashboardProcessControlState = {
    managed: DashboardProcessControlEntry[];
    unsupported: {
        dashboardService: true;
        forceRelease: true;
        reason: string;
    };
};

export type DashboardScanOptions = {
    from?: number;
    count?: number;
    timeoutMs?: number;
    managerPort?: number;
    fetchImpl?: FetchLike;
};

export type DashboardScanResult = {
    manager: {
        port: number;
        rangeFrom: number;
        rangeTo: number;
        checkedAt: string;
        proxy: DashboardProxyInfo;
        registry?: DashboardRegistryStatus;
        profiles?: DashboardProfile[];
    };
    instances: DashboardInstance[];
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type DashboardRegistryScan = {
    from: number;
    count: number;
};

export type DashboardRegistryUi = {
    selectedPort: number | null;
    selectedTab: DashboardDetailTab;
    sidebarCollapsed: boolean;
    activityDockCollapsed: boolean;
    activityDockHeight: number;
    activitySeenAt: string | null;
    activitySeenByPort: Record<string, string>;
    uiTheme: DashboardUiTheme;
    locale: DashboardLocale;
    sidebarMode: DashboardSidebarMode;
    notesSelectedPath: string | null;
    notesViewMode: DashboardNotesViewMode;
    notesAuthoringMode: DashboardNotesAuthoringMode;
    notesWordWrap: boolean;
    notesVimMode: boolean;
    notesTreeWidth: number;
    notesGraphSettings: DashboardNotesGraphSettings;
    showLatestActivityTitles: boolean;
    showInlineLabelEditor: boolean;
    showSidebarRuntimeLine: boolean;
    showSelectedRowActions: boolean;
    dashboardShortcutsEnabled: boolean;
    dashboardShortcutKeymap: DashboardShortcutKeymap;
    diffRootPolicy: DashboardDiffRootPolicy;
    diffPinnedRootByPort: Record<string, string>;
    diffRecentRepoRoots: string[];
    diffDefaultMode: DashboardDiffMode;
    diffBaseRef: string;
    diffIncludeUntracked: boolean;
    rightFolderRootPath: string | null;
};

export type DashboardRegistryInstance = {
    label: string | null;
    favorite: boolean;
    group: string | null;
    hidden: boolean;
    notes: string | null;
};

export type DashboardRegistry = {
    scan: DashboardRegistryScan;
    ui: DashboardRegistryUi;
    instances: Record<string, DashboardRegistryInstance>;
    profiles: Record<DashboardProfileId, Partial<DashboardProfile>>;
    activeProfileFilter: DashboardProfileId[];
    telegramHub: TelegramHubConfig;
};

export type DashboardRegistryStatus = {
    path: string;
    loaded: boolean;
    error: string | null;
    ui: DashboardRegistryUi;
    dashboardHome?: string;
    migratedFrom?: string | null;
};

export type DashboardRegistryPatch = {
    scan?: Partial<DashboardRegistryScan>;
    ui?: Partial<DashboardRegistryUi>;
    instances?: Record<string, Partial<DashboardRegistryInstance> | null>;
    profiles?: Record<DashboardProfileId, Partial<DashboardProfile> | null>;
    activeProfileFilter?: DashboardProfileId[];
    telegramHub?: Partial<TelegramHubConfig>;
};

export type DashboardNoteTreeEntry = {
    path: string;
    name: string;
    kind: 'file' | 'folder';
    mtimeMs: number;
    size: number;
    children?: DashboardNoteTreeEntry[];
};

export type DashboardNoteFileResponse = {
    path: string;
    name: string;
    content: string;
    revision: string;
    mtimeMs: number;
    size: number;
};

export type DashboardNoteSearchResult = {
    path: string;
    line: number;
    content: string;
    context: string;
    kind: 'path' | 'content';
};

export type DashboardPutNoteRequest = {
    path: string;
    content: string;
    baseRevision?: string;
};

export type DashboardNoteAssetUploadRequest = {
    notePath: string;
    mime: string;
    dataBase64: string;
};

export type DashboardNoteAssetResponse = {
    ok: true;
    path: string;
    markdown: string;
    mime: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'application/pdf';
    size: number;
};

export type DashboardTrashNoteKind = 'file' | 'folder';

export type DashboardTrashNoteResponse = {
    path: string;
    kind: DashboardTrashNoteKind;
    deletedTo: 'os-trash' | 'dashboard-trash';
    restoreHint?: string;
};

export type NoteLinkStatus = 'resolved' | 'missing' | 'ambiguous';

export type NoteIndexWarningCode =
    | 'frontmatter_parse_error'
    | 'frontmatter_unsupported_value'
    | 'invalid_wikilink_target'
    | 'note_file_too_large'
    | 'note_symlink_skipped';

export type NoteIndexWarning = {
    code: NoteIndexWarningCode;
    path: string;
    message: string;
    line?: number;
    column?: number;
};

export type NoteLinkReason = 'not_found' | 'invalid_target' | 'ambiguous';

export type NoteLinkRef = {
    sourcePath: string;
    raw: string;
    target: string;
    displayText?: string;
    heading?: string;
    line: number;
    column: number;
    startOffset: number;
    endOffset: number;
    status: NoteLinkStatus;
    resolvedPath?: string;
    candidatePaths?: string[];
    reason?: NoteLinkReason;
};

export type NoteMetadata = {
    path: string;
    title: string;
    aliases: string[];
    tags: string[];
    created?: string;
    mtimeMs: number;
    size: number;
    revision: string;
    frontmatterError?: string;
};

export type NoteGraphNode = {
    id: string;
    title: string;
    kind: 'note' | 'missing' | 'ambiguous' | 'tag' | 'attachment';
    path?: string;
    candidatePaths?: string[];
};

export type NoteGraphEdge = {
    source: string;
    target: string;
    raw: string;
    status: NoteLinkStatus;
    resolvedPath?: string;
};

export type VaultIndexSnapshot = {
    version: number;
    notes: NoteMetadata[];
    outgoingLinks: Record<string, NoteLinkRef[]>;
    backlinks: Record<string, NoteLinkRef[]>;
    unresolvedLinks: NoteLinkRef[];
    graph: { nodes: NoteGraphNode[]; edges: NoteGraphEdge[] };
    errors: NoteIndexWarning[];
};

export type NotesCapability = {
    available: boolean;
    version?: string;
    command?: string;
    reason?: string;
};

export type DashboardNotesCapabilities = {
    ripgrep: NotesCapability;
    git: NotesCapability;
    fileWatching: NotesCapability & { provider?: 'fs.watch' | 'watcher' };
    pdf: NotesCapability;
};
