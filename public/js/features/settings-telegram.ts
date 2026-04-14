// ── Telegram Settings ──
import { apiJson } from '../api.js';
import type { SettingsData } from './settings-types.js';

export async function saveTelegramSettings(): Promise<void> {
    const token = (document.getElementById('tgToken') as HTMLInputElement)?.value.trim() || '';
    const chatIdsRaw = (document.getElementById('tgChatIds') as HTMLInputElement)?.value.trim() || '';
    const allowedChatIds = chatIdsRaw
        ? chatIdsRaw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
        : [];
    await apiJson('/api/settings', 'PUT', { telegram: { token, allowedChatIds } });
}

export async function setTelegram(enabled: boolean): Promise<void> {
    document.getElementById('tgOn')?.classList.toggle('active', enabled);
    document.getElementById('tgOff')?.classList.toggle('active', !enabled);
    await apiJson('/api/settings', 'PUT', { telegram: { enabled } });
}

export async function setForwardAll(enabled: boolean): Promise<void> {
    document.getElementById('tgForwardOn')?.classList.toggle('active', enabled);
    document.getElementById('tgForwardOff')?.classList.toggle('active', !enabled);
    await apiJson('/api/settings', 'PUT', { telegram: { forwardAll: enabled } });
}

export async function setTelegramMentionOnly(enabled: boolean): Promise<void> {
    document.getElementById('tgMentionOn')?.classList.toggle('active', enabled);
    document.getElementById('tgMentionOff')?.classList.toggle('active', !enabled);
    await apiJson('/api/settings', 'PUT', { telegram: { mentionOnly: enabled } });
}

export function loadTelegramSettings(s: SettingsData): void {
    if (!s.telegram) return;
    const tg = s.telegram;
    document.getElementById('tgOn')?.classList.toggle('active', !!tg.enabled);
    document.getElementById('tgOff')?.classList.toggle('active', !tg.enabled);
    const tgToken = document.getElementById('tgToken') as HTMLInputElement | null;
    if (tg.token && tgToken) tgToken.value = tg.token;
    const tgChatIds = document.getElementById('tgChatIds') as HTMLInputElement | null;
    if (tg.allowedChatIds?.length && tgChatIds) {
        tgChatIds.value = tg.allowedChatIds.join(', ');
    }
    const fwdOn = tg.forwardAll !== false;
    document.getElementById('tgForwardOn')?.classList.toggle('active', fwdOn);
    document.getElementById('tgForwardOff')?.classList.toggle('active', !fwdOn);
    const mentionOnly = tg.mentionOnly !== false;
    document.getElementById('tgMentionOn')?.classList.toggle('active', mentionOnly);
    document.getElementById('tgMentionOff')?.classList.toggle('active', !mentionOnly);
}
