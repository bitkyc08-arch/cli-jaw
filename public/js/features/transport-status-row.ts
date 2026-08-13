import { api } from '../api.js';
import { escapeHtml } from '../render.js';
import { t } from './i18n.js';

export type MessengerChannel = 'telegram' | 'discord' | 'slack';

export type TransportStatus = {
    configured: boolean;
    activeInbound: boolean;
    sendCapable: boolean;
    reason?: string;
};

export type ChannelHealth = {
    /** @deprecated Use activeInboundChannels for the actual running set. */
    activeInbound: MessengerChannel;
    activeInboundChannels: MessengerChannel[];
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

function isMessengerChannel(value: unknown): value is MessengerChannel {
    return value === 'telegram' || value === 'discord' || value === 'slack';
}

export function parseChannelHealth(payload: unknown): ChannelHealth | null {
    if (!payload || typeof payload !== 'object') return null;
    const channels = (payload as { channels?: unknown }).channels;
    if (!channels || typeof channels !== 'object') return null;
    const row = channels as Record<string, unknown>;
    const rawActiveChannels = row['activeInboundChannels'];
    let activeInboundChannels: MessengerChannel[] | null;
    if (rawActiveChannels !== undefined) {
        activeInboundChannels = Array.isArray(rawActiveChannels)
            && rawActiveChannels.every(isMessengerChannel)
            ? [...new Set(rawActiveChannels)]
            : null;
    } else {
        const legacyActive = row['activeInbound'];
        activeInboundChannels = isMessengerChannel(legacyActive) ? [legacyActive] : null;
    }
    if (!activeInboundChannels) return null;
    const active = row['activeInbound'];
    if (!isMessengerChannel(active)) return null;
    if (!isTransportStatus(row['telegram']) || !isTransportStatus(row['discord'])) return null;
    // Slack is tolerated as absent: a newer bundle can be served against an
    // older running server during a rolling update, and rejecting the whole
    // payload would hide Telegram and Discord health too.
    const slack = isTransportStatus(row['slack'])
        ? row['slack']
        : { configured: false, activeInbound: false, sendCapable: false, reason: 'unavailable' };
    return {
        activeInbound: active,
        activeInboundChannels,
        telegram: row['telegram'],
        discord: row['discord'],
        slack,
    };
}

export function transportChipLabels(status: TransportStatus): string[] {
    const chips: string[] = [];
    chips.push(status.configured ? t('settings.channel.configured') : t('settings.channel.notConfigured'));
    if (status.sendCapable) chips.push(t('settings.channel.sendCapable'));
    if (status.activeInbound) chips.push(t('settings.channel.activeInbound'));
    return chips;
}

function renderTransportBlock(
    label: string,
    status: TransportStatus,
    showHint: boolean,
): string {
    const chips = transportChipLabels(status)
        .map(text => `<span class="transport-status-chip">${escapeHtml(text)}</span>`)
        .join('');
    // not_attach_instance: tokens exist but another instance owns the socket —
    // say so, or the guarded instance just reads as silently broken.
    const hint = status.reason === 'not_attach_instance'
        ? `<p class="transport-status-hint">${escapeHtml(t('settings.channel.notAttachInstanceHint'))}</p>`
        : showHint && status.configured && status.sendCapable && !status.activeInbound
            ? `<p class="transport-status-hint">${escapeHtml(t('settings.channel.sendOnlyHint'))}</p>`
            : '';
    return `
        <div class="transport-status-block">
            <div class="transport-status-label">${escapeHtml(label)}</div>
            <div class="transport-status-chips">${chips}</div>
            ${hint}
        </div>`;
}

export function renderTransportStatusRow(container: HTMLElement, health: ChannelHealth): void {
    container.innerHTML = `
        <h4 class="section-title-row">
            <span><span data-icon="radio"></span> ${escapeHtml(t('settings.channel.statusTitle'))}</span>
        </h4>
        ${renderTransportBlock('Telegram', health.telegram, true)}
        ${renderTransportBlock('Discord', health.discord, true)}
        ${renderTransportBlock('Slack', health.slack, true)}
    `;
}

export async function refreshTransportStatusRow(): Promise<void> {
    const container = document.getElementById('channelTransportStatus');
    if (!container) return;
    try {
        const payload = await api<{ channels?: unknown }>('/api/health');
        const health = parseChannelHealth(payload);
        if (!health) {
            container.innerHTML = '';
            container.style.display = 'none';
            return;
        }
        renderTransportStatusRow(container, health);
        container.style.display = '';
    } catch {
        container.innerHTML = '';
        container.style.display = 'none';
    }
}
