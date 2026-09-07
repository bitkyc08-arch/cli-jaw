import { isRetiredCliSelection } from '../../../src/types/cli-engine.js';
// ── Active Channel & Fallback Order ──
import { apiJson, api } from '../api.js';
import { escapeHtml } from '../render.js';
import { getCliMeta } from '../constants.js';
import { providerLabel } from '../provider-icons.js';
import { t } from './i18n.js';
import { refreshTransportStatusRow } from './transport-status-row.js';
import { openSetupGuideIfUnconfigured } from './channel-setup-guide.js';
import type { SettingsData } from './settings-types.js';

export type MessengerChannel = 'telegram' | 'discord' | 'slack';
const CHANNELS: MessengerChannel[] = ['telegram', 'discord', 'slack'];

/** Read the enabled set from the server rather than rebuilding it from nothing.
 *
 *  This returned [], so every toggle sent a SINGLETON set. Under the v3 model
 *  that was harmless — one channel was active at a time. Under v4 it means
 *  enabling a channel tears down every other gateway, because
 *  restartMessagingRuntime acts on the enabled-set difference: someone running
 *  Slack and Telegram lost Telegram inbound by touching the Slack tab (#445). */
async function readEnabledChannels(): Promise<MessengerChannel[]> {
    try {
        const data = await api<Record<string, unknown>>('/api/settings');
        const messaging = data?.['messaging'] as { enabledChannels?: unknown } | undefined;
        const enabled = messaging?.enabledChannels;
        if (!Array.isArray(enabled)) return [];
        return enabled.filter((c): c is MessengerChannel => CHANNELS.includes(c as MessengerChannel));
    } catch {
        // Unreadable state is not evidence that nothing is enabled; returning []
        // would recreate the very bug this replaces.
        return [];
    }
}

export async function setChannelEnabled(ch: MessengerChannel, enabled: boolean): Promise<void> {
    const current = await readEnabledChannels();
    const enabledChannels = enabled
        ? [...new Set([...current, ch])]
        : current.filter(item => item !== ch);
    await apiJson('/api/settings', 'PUT', { messaging: { enabledChannels } });
    await refreshTransportStatusRow();
}

export async function setHomeChannel(ch: MessengerChannel): Promise<void> {
    document.getElementById('chTelegram')?.classList.toggle('active', ch === 'telegram');
    document.getElementById('chDiscord')?.classList.toggle('active', ch === 'discord');
    document.getElementById('chSlack')?.classList.toggle('active', ch === 'slack');
    document.getElementById('channelTelegramSettings')?.style.setProperty('display', ch === 'telegram' ? '' : 'none');
    document.getElementById('channelDiscordSettings')?.style.setProperty('display', ch === 'discord' ? '' : 'none');
    document.getElementById('channelSlackSettings')?.style.setProperty('display', ch === 'slack' ? '' : 'none');
    await apiJson('/api/settings', 'PUT', { messaging: { homeChannel: ch } });
    await refreshTransportStatusRow();
}

/**
 * @deprecated Use setChannelEnabled + setHomeChannel. Kept temporarily for
 *             classic entry points that still bind the channel tabs.
 */
export async function setActiveChannel(ch: MessengerChannel): Promise<void> {
    await setChannelEnabled(ch, true);
    await setHomeChannel(ch);
    openSetupGuideIfUnconfigured(ch);
}

export function loadActiveChannel(s: SettingsData): void {
    const messaging = s.messaging;
    const ch: MessengerChannel = messaging?.homeChannel && CHANNELS.includes(messaging.homeChannel)
        ? messaging.homeChannel
        : 'telegram';
    document.getElementById('chTelegram')?.classList.toggle('active', ch === 'telegram');
    document.getElementById('chDiscord')?.classList.toggle('active', ch === 'discord');
    document.getElementById('chSlack')?.classList.toggle('active', ch === 'slack');
    document.getElementById('channelTelegramSettings')?.style.setProperty('display', ch === 'telegram' ? '' : 'none');
    document.getElementById('channelDiscordSettings')?.style.setProperty('display', ch === 'discord' ? '' : 'none');
    document.getElementById('channelSlackSettings')?.style.setProperty('display', ch === 'slack' ? '' : 'none');
    void refreshTransportStatusRow();
}

export function loadFallbackOrder(s: SettingsData): void {
    const container = document.getElementById('fallbackOrderList');
    if (!container) return;
    const allClis = Object.keys(s.perCli || {}).filter(cli => !isRetiredCliSelection(cli));
    const active = s.fallbackOrder || [];
    const slotCount = Math.min(allClis.length - 1, 3);

    let html = '';
    for (let i = 0; i < slotCount; i++) {
        const current = active[i] || '';
        const retiredOption = isRetiredCliSelection(current) ? '<option value="jwc" disabled selected>JWC (retired)</option>' : '';
        const opts = retiredOption + allClis.map(cli =>
            `<option value="${escapeHtml(cli)}" ${cli === current ? 'selected' : ''}>${escapeHtml(getCliMeta(cli)?.label || providerLabel(cli))}</option>`
        ).join('');
        html += `
            <div class="settings-row sub-row">
                <label style="min-width:60px">Fallback ${i + 1}</label>
                <select id="fallback${i}"
                    style="font-size:11px;padding:4px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:4px;flex:1">
                    <option value="">${t('settings.none')}</option>
                    ${opts}
                </select>
            </div>`;
    }
    container.innerHTML = html;
}

export async function saveFallbackOrder(): Promise<void> {
    const selects = document.querySelectorAll<HTMLSelectElement>('#fallbackOrderList select');
    const fallbackOrder = [...selects].map(s => s.value).filter(Boolean);
    await apiJson('/api/settings', 'PUT', { fallbackOrder });
}
