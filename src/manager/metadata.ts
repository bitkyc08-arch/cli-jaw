import { basename } from 'node:path';
import { createHash } from 'node:crypto';

export type DashboardSettingsMetadata = {
    homeDisplay: string | null;
    workingDir: string | null;
    currentCli: string | null;
    currentModel: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function readString(source: Record<string, unknown> | null, keys: string[]): string | null {
    if (!source) return null;
    for (const key of keys) {
        const value = source[key];
        if (typeof value === 'string' && value.trim()) return value;
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
    const data = asRecord(root?.data);
    const source = data || root;

    const workingDir = readString(source, ['workingDir', 'cwd']);
    const homeDisplay = readString(source, ['jawHome', 'JAW_HOME', 'home', 'homePath']) || workingDir;
    const currentCli = readString(source, ['cli', 'currentCli']);
    let currentModel = readString(source, ['model', 'currentModel']);

    if (!currentModel && currentCli && source) {
        const overrides = asRecord(source.activeOverrides);
        const cliOverride = overrides ? asRecord(overrides[currentCli]) : null;
        const perCli = asRecord(source.perCli);
        const cliSettings = perCli ? asRecord(perCli[currentCli]) : null;
        currentModel = readString(cliOverride, ['model'])
            || readString(cliSettings, ['model']);
    }

    return { homeDisplay, workingDir, currentCli, currentModel };
}
