// Channel health parsing ported from public/js/features/transport-status-row.ts.

export type TransportStatus = {
    configured: boolean;
    activeInbound: boolean;
    sendCapable: boolean;
    reason?: string;
};

export type ChannelHealth = {
    activeInbound: 'telegram' | 'discord';
    telegram: TransportStatus;
    discord: TransportStatus;
};

function isTransportStatus(value: unknown): value is TransportStatus {
    if (!value || typeof value !== 'object') return false;
    const row = value as Record<string, unknown>;
    return typeof row['configured'] === 'boolean'
        && typeof row['activeInbound'] === 'boolean'
        && typeof row['sendCapable'] === 'boolean';
}

export function parseChannelHealth(payload: unknown): ChannelHealth | null {
    if (!payload || typeof payload !== 'object') return null;
    const channels = (payload as { channels?: unknown }).channels;
    if (!channels || typeof channels !== 'object') return null;
    const row = channels as Record<string, unknown>;
    if (row['activeInbound'] !== 'telegram' && row['activeInbound'] !== 'discord') return null;
    if (!isTransportStatus(row['telegram']) || !isTransportStatus(row['discord'])) return null;
    return { activeInbound: row['activeInbound'], telegram: row['telegram'], discord: row['discord'] };
}
