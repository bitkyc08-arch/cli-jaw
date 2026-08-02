// ── Active Channel & Fallback Order ──
import { apiJson } from '../api.js';
import { escapeHtml } from '../render.js';
import { getCliMeta } from '../constants.js';
import { providerLabel } from '../provider-icons.js';
import { t } from './i18n.js';
import { refreshTransportStatusRow } from './transport-status-row.js';
import type { SettingsData } from './settings-types.js';

export async function setActiveChannel(ch: 'telegram' | 'discord' | 'slack'): Promise<void> {
    document.getElementById('chTelegram')?.classList.toggle('active', ch === 'telegram');
    document.getElementById('chDiscord')?.classList.toggle('active', ch === 'discord');
    document.getElementById('chSlack')?.classList.toggle('active', ch === 'slack');
    document.getElementById('channelTelegramSettings')?.style.setProperty('display', ch === 'telegram' ? '' : 'none');
    document.getElementById('channelDiscordSettings')?.style.setProperty('display', ch === 'discord' ? '' : 'none');
    document.getElementById('channelSlackSettings')?.style.setProperty('display', ch === 'slack' ? '' : 'none');
    await apiJson('/api/settings', 'PUT', { channel: ch });
    await refreshTransportStatusRow();
}

export function loadActiveChannel(s: SettingsData): void {
    const ch = s.channel || 'telegram';
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
    const allClis = Object.keys(s.perCli || {});
    const active = s.fallbackOrder || [];
    const slotCount = Math.min(allClis.length - 1, 3);

    let html = '';
    for (let i = 0; i < slotCount; i++) {
        const current = active[i] || '';
        const opts = allClis.map(cli =>
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
