export type DashboardInstanceStatus =
    | 'online'
    | 'offline'
    | 'timeout'
    | 'error'
    | 'unknown';

export type DashboardServiceMode = 'unknown' | 'ad-hoc' | 'service' | 'manager';
export type DashboardPreviewMode = 'direct' | 'proxy';
export type DashboardLifecycleAction = 'start' | 'stop' | 'restart' | 'perm' | 'unperm';
export type DashboardLifecycleOwner = 'none' | 'external' | 'manager' | 'launchd';
export type DashboardDetailTab = 'overview' | 'preview' | 'logs' | 'settings';
export type DashboardUiTheme = 'auto' | 'dark' | 'light';
export type DashboardLocale = 'ko' | 'en' | 'zh' | 'ja';
export type DashboardSidebarMode = 'instances' | 'notes' | 'settings';
export type DashboardNotesViewMode = 'raw' | 'split' | 'preview' | 'settings';
export type DashboardNotesAuthoringMode = 'plain' | 'rich' | 'wysiwyg';
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

export type DashboardLaunchdState = {
    plistExists: boolean;
    loaded: boolean;
    pid: number | null;
    label: string;
    plistPath: string;
};

export type DashboardLifecycleExpectedState = 'online' | 'offline' | 'restart-detected';

export type DashboardLifecycleResult = {
    ok: boolean;
    action: DashboardLifecycleAction;
    port: number;
    status: 'started' | 'stopped' | 'restarted' | 'permed' | 'unpermed' | 'rejected' | 'error';
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
    notesTreeWidth: number;
    showLatestActivityTitles: boolean;
    showInlineLabelEditor: boolean;
    showSidebarRuntimeLine: boolean;
    showSelectedRowActions: boolean;
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

export type DashboardPutNoteRequest = {
    path: string;
    content: string;
    baseRevision?: string;
};

export type DashboardTrashNoteKind = 'file' | 'folder';

export type DashboardTrashNoteResponse = {
    path: string;
    kind: DashboardTrashNoteKind;
    deletedTo: 'os-trash' | 'dashboard-trash';
    restoreHint?: string;
};
