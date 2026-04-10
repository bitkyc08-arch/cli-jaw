// ── Settings Type Definitions ──

export interface PerCliConfig { model?: string; effort?: string; fastMode?: boolean; contextWindow?: boolean; contextWindowSize?: number; contextCompactLimit?: number; }
export interface TelegramConfig { enabled?: boolean; token?: string; allowedChatIds?: number[]; forwardAll?: boolean; }
export interface DiscordConfig { enabled?: boolean; token?: string; guildId?: string; channelIds?: string[]; forwardAll?: boolean; allowBots?: boolean; mentionOnly?: boolean; }
export interface QuotaWindow { label: string; percent: number; resetsAt?: string | number | null; }
export interface QuotaEntry {
    account?: { email?: string; type?: string; plan?: string; tier?: string };
    windows?: QuotaWindow[];
    authenticated?: boolean;
    error?: boolean;
    reason?: string;
}
export interface SettingsData {
    cli: string; workingDir: string; permissions: string; locale?: string;
    perCli?: Record<string, PerCliConfig>;
    activeOverrides?: Record<string, PerCliConfig>;
    telegram?: TelegramConfig;
    discord?: DiscordConfig;
    channel?: 'telegram' | 'discord';
    fallbackOrder?: string[];
    memory?: { cli?: string };
    stt?: { engine?: string; geminiKeySet?: boolean; geminiKeyLast4?: string; geminiModel?: string; whisperModel?: string; openaiKeySet?: boolean; openaiKeyLast4?: string };
}
