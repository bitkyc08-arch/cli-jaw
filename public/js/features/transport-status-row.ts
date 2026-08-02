import { api } from '../api.js';
import { escapeHtml } from '../render.js';
import { t } from './i18n.js';

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
    // Extract to a local so TypeScript narrows it for the return below; a
    // repeated property read is not narrowed.
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
    const hint = showHint && status.configured && status.sendCapable && !status.activeInbound
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
