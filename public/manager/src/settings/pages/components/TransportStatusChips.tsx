import { useCallback, useEffect, useRef, useState } from 'react';
import type { SettingsClient } from '../../types';

export type TransportStatus = {
    configured: boolean;
    activeInbound: boolean;
    sendCapable: boolean;
    reason?: string;
};

export type ChannelHealth = {
    activeInbound: 'telegram' | 'discord' | 'slack';
    telegram: TransportStatus;
    discord: TransportStatus;
    slack: TransportStatus;
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
    const active = row['activeInbound'];
    if (active !== 'telegram' && active !== 'discord' && active !== 'slack') return null;
    if (!isTransportStatus(row['telegram'])
        || !isTransportStatus(row['discord'])
        || !isTransportStatus(row['slack'])) return null;
    return {
        activeInbound: active,
        telegram: row['telegram'],
        discord: row['discord'],
        slack: row['slack'],
    };
}

/** Human-readable text for the health `reason` codes channel-health emits. */
const TRANSPORT_REASON_LABELS: Record<string, string> = {
    missing_chat_id: 'No chat ID',
    missing_channel_id: 'No channel ID',
    missing_app_token: 'No app token (outbound only)',
};

export function transportChipLabels(status: TransportStatus): string[] {
    const chips: string[] = [];
    chips.push(status.configured ? 'Configured' : 'Not configured');
    if (status.sendCapable) chips.push('Send-capable');
    if (status.activeInbound) chips.push('Active inbound');
    // Surface WHY a configured transport is limited. Without this a Slack
    // instance stuck on missing_app_token reads as simply "Configured".
    if (status.reason && status.reason !== 'disabled') {
        chips.push(TRANSPORT_REASON_LABELS[status.reason] || status.reason);
    }
    return chips;
}

type Props = {
    client: SettingsClient;
    channel: 'telegram' | 'discord' | 'slack';
};

export function TransportStatusChips({ client, channel }: Props) {
    const [health, setHealth] = useState<ChannelHealth | null>(null);
    const [error, setError] = useState<string | null>(null);
    const mounted = useRef(true);

    const refresh = useCallback(async () => {
        try {
            const payload = await client.get<unknown>('/api/health');
            if (!mounted.current) return;
            const parsed = parseChannelHealth(payload);
            setHealth(parsed);
            setError(parsed ? null : 'Channel health unavailable on this instance.');
        } catch (err: unknown) {
            if (!mounted.current) return;
            setHealth(null);
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [client]);

    useEffect(() => {
        mounted.current = true;
        void refresh();
        return () => {
            mounted.current = false;
        };
    }, [refresh]);

    const status = health?.[channel] ?? null;
    const showHint = Boolean(status?.configured && status.sendCapable && !status.activeInbound);

    return (
        <div className="settings-transport-status" role="status" aria-live="polite">
            {error ? <p className="settings-field-hint">{error}</p> : null}
            {status ? (
                <>
                    <div className="settings-transport-chips">
                        {transportChipLabels(status).map(label => (
                            <span key={label} className="settings-health-pill is-ok">{label}</span>
                        ))}
                    </div>
                    {showHint ? (
                        <p className="settings-field-hint">
                            This transport is not receiving inbound messages, but send-only delivery remains available.
                        </p>
                    ) : null}
                </>
            ) : null}
            <button
                type="button"
                className="settings-action settings-action-discard"
                onClick={() => void refresh()}
            >
                Refresh transport status
            </button>
        </div>
    );
}
