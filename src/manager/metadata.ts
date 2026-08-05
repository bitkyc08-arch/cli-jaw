import { basename } from 'node:path';
import { createHash } from 'node:crypto';

export type DashboardSettingsMetadata = {
    homeDisplay: string | null;
    workingDir: string | null;
    projectDirs: string[] | null;
    currentCli: string | null;
    currentModel: string | null;
    // Whether the instance runs several chat sessions. The manager only offers the
    // session tree for instances that actually have one (072 §1.4).
    multiSession: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function readString(source: Record<string, unknown> | null, keys: string[]): string | null {
    if (!source) return null;
    for (const key of keys) {
        const value = source[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
}

export function deriveDashboardInstanceId(homePath: string | null): string | null {
    if (!homePath) return null;
    const base = basename(homePath);
    if (base === '.cli-jaw') return 'default';
    const hash = createHash('md5').update(homePath).digest('hex').slice(0, 8);
    return `${base.replace(/^\./, '')}-${hash}`;
}

export function normalizeSettingsMetadata(settingsBody: unknown): DashboardSettingsMetadata {
    const root = asRecord(settingsBody);
    const data = asRecord(root?.["data"]);
    const source = data || root;

    const workingDir = readString(source, ['workingDir', 'cwd']);
    const homeDisplay = readString(source, ['jawHome', 'JAW_HOME', 'home', 'homePath']) || workingDir;
    const currentCli = readString(source, ['cli', 'currentCli']);
    let currentModel = readString(source, ['model', 'currentModel']);

    if (!currentModel && currentCli && source) {
        const overrides = asRecord(source["activeOverrides"]);
        const cliOverride = overrides ? asRecord(overrides[currentCli]) : null;
        const perCli = asRecord(source["perCli"]);
        const cliSettings = perCli ? asRecord(perCli[currentCli]) : null;
        currentModel = readString(cliOverride, ['model'])
            || readString(cliSettings, ['model']);
    }

    const rawProjectDirs = source?.["projectDirs"];
    const filteredDirs = Array.isArray(rawProjectDirs) && rawProjectDirs.length > 0
        ? rawProjectDirs.filter((d): d is string => typeof d === 'string' && d.trim().length > 0).map(d => d.trim())
        : [];
    const projectDirs = filteredDirs.length > 0 ? filteredDirs : null;

    // Absent or malformed means off. An instance too old to report the flag has no
    // session list to expand anyway, so treating it as single-session is correct.
    const multiSession = asRecord(source?.["multiSession"])?.["enabled"] === true;

    return { homeDisplay, workingDir, projectDirs, currentCli, currentModel, multiSession };
}
