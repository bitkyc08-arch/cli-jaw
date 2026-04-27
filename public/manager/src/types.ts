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
    lifecycle?: DashboardLifecycleCapability;
    lastCheckedAt: string;
    healthReason: string | null;
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

export type DashboardLifecycleResult = {
    ok: boolean;
    action: DashboardLifecycleAction;
    port: number;
    status: 'started' | 'stopped' | 'restarted' | 'rejected' | 'error';
    message: string;
    home: string | null;
    pid: number | null;
    command: string[];
    stderr?: string;
    stdout?: string;
};

export type DashboardScanResult = {
    manager: {
        port: number;
        rangeFrom: number;
        rangeTo: number;
        checkedAt: string;
        proxy: DashboardProxyInfo;
    };
    instances: DashboardInstance[];
};

export type DashboardInstanceGroup = {
    id: 'running' | 'attention' | 'offline';
    label: string;
    instances: DashboardInstance[];
};
