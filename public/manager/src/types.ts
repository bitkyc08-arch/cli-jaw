export type DashboardInstanceStatus =
    | 'online'
    | 'offline'
    | 'timeout'
    | 'error'
    | 'unknown';

export type DashboardServiceMode = 'unknown' | 'ad-hoc' | 'service' | 'manager';
export type DashboardPreviewMode = 'direct' | 'proxy';
export type DashboardLifecycleAction = 'start' | 'stop' | 'restart';
export type DashboardLifecycleOwner = 'none' | 'external' | 'manager';
export type DashboardDetailTab = 'overview' | 'preview' | 'logs' | 'settings';
export type DashboardUiTheme = 'auto' | 'dark' | 'light';
export type DashboardProfileId = string;

export type DashboardProxyInfo = {
    enabled: boolean;
    basePath: string;
    allowedFrom: number;
    allowedTo: number;
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
    reason: string;
    defaultHome: string;
    commandPreview: string[];
    pid: number | null;
};

export type DashboardLifecycleExpectedState = 'online' | 'offline' | 'restart-detected';

export type DashboardLifecycleResult = {
    ok: boolean;
    action: DashboardLifecycleAction;
    port: number;
    status: 'started' | 'stopped' | 'restarted' | 'rejected' | 'error';
    message: string;
    home: string | null;
    pid: number | null;
    command: string[];
    expectedStateAfter?: DashboardLifecycleExpectedState;
    stderr?: string;
    stdout?: string;
};

export type ManagerEvent =
    | { kind: 'scan-completed'; from: number; to: number; reachable: number; at: string }
    | { kind: 'scan-failed'; reason: string; at: string }
    | { kind: 'lifecycle-result'; port: number; action: DashboardLifecycleAction; status: string; message: string; at: string }
    | { kind: 'health-changed'; port: number; from: DashboardInstanceStatus; to: DashboardInstanceStatus; reason: string | null; at: string }
    | { kind: 'version-mismatch'; port: number; expected: string | null; seen: string; at: string }
    | { kind: 'port-collision'; port: number; pids: number[]; at: string };

export type HealthEvent = {
    port: number;
    at: string;
    status: DashboardInstanceStatus;
    reason: string | null;
    versionSeen: string | null;
};

export type InstanceLogLine = {
    ts: string;
    level: 'info' | 'warn' | 'error';
    text: string;
};

export type InstanceLogSnapshot = {
    port: number;
    fetchedAt: string;
    lines: InstanceLogLine[];
    truncated: boolean;
    source: 'runtime' | 'health' | 'none';
    reason?: string;
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

export type DashboardInstanceGroup = {
    id: string;
    label: string;
    instances: DashboardInstance[];
};

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
    uiTheme: DashboardUiTheme;
};

export type DashboardRegistryInstance = {
    label: string | null;
    favorite: boolean;
    group: string | null;
    hidden: boolean;
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
};

export type DashboardRegistryPatch = {
    scan?: Partial<DashboardRegistryScan>;
    ui?: Partial<DashboardRegistryUi>;
    instances?: Record<string, Partial<DashboardRegistryInstance> | null>;
    profiles?: Record<DashboardProfileId, Partial<DashboardProfile> | null>;
    activeProfileFilter?: DashboardProfileId[];
};

export type DashboardRegistryLoadResult = {
    registry: DashboardRegistry;
    status: DashboardRegistryStatus;
};
