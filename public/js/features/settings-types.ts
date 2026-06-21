// ── Settings Type Definitions ──

export interface PerCliConfig { provider?: string; model?: string; effort?: string; fastMode?: boolean; contextWindow?: boolean; contextWindowSize?: number; contextCompactLimit?: number; }
export interface TelegramConfig { enabled?: boolean; token?: string; allowedChatIds?: number[]; forwardAll?: boolean; mentionOnly?: boolean; }
export interface DiscordConfig { enabled?: boolean; token?: string; guildId?: string; channelIds?: string[]; forwardAll?: boolean; allowBots?: boolean; mentionOnly?: boolean; }
export interface QuotaWindow {
    label: string;
    percent: number;
    resetsAt?: string | number | null;
    modelId?: string;
    precision?: 'binary';
    status?: 'available' | 'exhausted';
}
export function resolveQuotaWindowDisplay(window: QuotaWindow): { percent: number | null; text: string } {
    if (window.precision === 'binary') {
        return {
            percent: null,
            text: window.status === 'exhausted' ? 'Exhausted' : 'Available',
        };
    }
    const percent = Math.max(0, Math.min(100, Math.round(window.percent)));
    return { percent, text: `${percent}%` };
}
export interface QuotaEntry {
    account?: { email?: string; type?: string; plan?: string; tier?: string };
    windows?: QuotaWindow[];
    authenticated?: boolean;
    error?: boolean;
    reason?: string;
    quotaCapable?: boolean;
    quotaSource?: string;
    sessionUsageCapable?: boolean;
    displayTier?: string;
    delegatedProvider?: string;
    billing?: { usedUsd?: number; limitUsd?: number; percent?: number; periodEnd?: string };
    sessionUsage?: {
        contextTokensUsed?: number | null;
        contextWindowTokens?: number | null;
        contextWindowUsage?: number | null;
        primaryModelId?: string | null;
        turnCount?: number | null;
    };
}
export interface PiProfileView { id: string; label: string; mode: string; endpoint: string; apiKind?: string; apiKeySet?: boolean; apiKeyLast4?: string; model: string; }
export interface PiSettingsView { defaultProfileId: string; profiles: PiProfileView[]; discoveredModels?: Record<string, string[]>; }
export interface SettingsData {
    cli: string; workingDir: string; permissions: string; locale?: string; showReasoning?: boolean;
    perCli?: Record<string, PerCliConfig>;
    activeOverrides?: Record<string, PerCliConfig>;
    telegram?: TelegramConfig;
    discord?: DiscordConfig;
    channel?: 'telegram' | 'discord';
    fallbackOrder?: string[];
    memory?: { cli?: string };
    projectDirs?: string[] | null;
    stt?: { engine?: string; geminiKeySet?: boolean; geminiKeyLast4?: string; geminiModel?: string; whisperModel?: string; openaiKeySet?: boolean; openaiKeyLast4?: string };
    pi?: PiSettingsView;
}
