// Shared types + small helpers for dock tabs (ported from
// public/js/features/settings-types.ts — UI freeze, port not import).
import type { DockClient } from './dock-client';

export interface PerCliConfig {
    provider?: string;
    model?: string;
    effort?: string;
    fastMode?: boolean;
    contextWindow?: boolean;
    contextWindowSize?: number;
    contextCompactLimit?: number;
}

export interface TelegramConfig {
    enabled?: boolean;
    token?: string;
    allowedChatIds?: number[];
    forwardAll?: boolean;
    mentionOnly?: boolean;
}

export interface DiscordConfig {
    enabled?: boolean;
    token?: string;
    guildId?: string;
    channelIds?: string[];
    forwardAll?: boolean;
    allowBots?: boolean;
    mentionOnly?: boolean;
}

export interface PiProfileView {
    id: string;
    label: string;
    mode: string;
    endpoint: string;
    apiKind?: string;
    apiKeySet?: boolean;
    apiKeyLast4?: string;
    model: string;
}

export interface PiSettingsView {
    defaultProfileId: string;
    profiles: PiProfileView[];
    discoveredModels?: Record<string, string[]>;
}

export interface SettingsData {
    cli: string;
    workingDir: string;
    permissions: string;
    locale?: string;
    perCli?: Record<string, PerCliConfig>;
    activeOverrides?: Record<string, PerCliConfig>;
    telegram?: TelegramConfig;
    discord?: DiscordConfig;
    channel?: 'telegram' | 'discord';
    fallbackOrder?: string[];
    memory?: { cli?: string; model?: string };
    stt?: {
        engine?: string;
        geminiKeySet?: boolean;
        geminiKeyLast4?: string;
        geminiModel?: string;
        whisperModel?: string;
        openaiKeySet?: boolean;
        openaiKeyLast4?: string;
    };
    pi?: PiSettingsView;
}

export interface DockTabProps {
    client: DockClient;
    /** true while the dock panel is open AND this tab is selected. */
    active: boolean;
}

/**
 * Dual-response compat (public/js/api.ts parity): instance endpoints answer
 * either `{ ok, data }` (ok() helper) or a bare payload. Unwrap when wrapped.
 */
export function unwrapData<T>(json: unknown): T {
    if (json && typeof json === 'object' && 'ok' in json && 'data' in json) {
        const wrapped = json as { ok: boolean; data: unknown };
        if (!wrapped.ok) throw new Error('instance api returned ok:false');
        return wrapped.data as T;
    }
    return json as T;
}
