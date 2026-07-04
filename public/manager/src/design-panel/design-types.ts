export type DesignPageSummary = {
    id: string;
    title: string;
    artifactKind: 'html';
    projectKey: string;
    updatedAt: string;
    revision: number;
};

export type DesignPageDetail = DesignPageSummary & {
    createdAt: string;
    promptPath: string | null;
    exportTarget: string | null;
    schemaWarning: string | null;
};

export type DesignRunStatus = {
    pageId: string;
    state: 'idle' | 'queued' | 'running' | 'done' | 'error';
    message?: string;
    startedAt?: string;
    finishedAt?: string;
};

export type DesignSnapshot = {
    id: string;
    pageId: string;
    label: 'before' | 'after' | 'recovery' | 'manual';
    createdAt: string;
};

export type DesignCatalogEntry = {
    id: string;
    title: string;
    kind: 'html';
    description?: string;
};

export type DesignLocalPaths = {
    pageDir: string;
    artifactPath: string;
    promptPath: string;
};
