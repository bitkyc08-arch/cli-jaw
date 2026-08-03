// ── Slack Settings ──
import { api, apiJson } from '../api.js';
import { openSetupGuideIfUnconfigured } from './channel-setup-guide.js';
import { hasSlackBotTokenPrefix, hasSlackAppTokenPrefix } from './channel-setup-rules.js';
import { t } from './i18n.js';
import type { SettingsData } from './settings-types.js';

// ── Guided setup card ──
// One-time bindings for the Slack setup card in settings: manifest copy,
// app-page shortcut, and inline token-prefix validation (error below the
// field, cleared once the value looks right — form-patterns on-blur timing).
let setupGuideBound = false;

export function initSlackSetupGuide(): void {
    if (setupGuideBound) return;
    setupGuideBound = true;

    document.getElementById('slack-copy-manifest')?.addEventListener('click', async (ev) => {
        const btn = ev.currentTarget as HTMLButtonElement;
        try {
            const json = await api<{ yaml?: string }>('/api/slack/manifest');
            const yaml = json?.yaml || '';
            if (!yaml) throw new Error('empty manifest');
            await navigator.clipboard.writeText(yaml);
            const original = btn.textContent || '';
            btn.textContent = t('settings.slack.guide.copyManifestDone');
            setTimeout(() => { btn.textContent = original; }, 2000);
        } catch {
            btn.textContent = t('settings.slack.guide.copyManifestFail');
            setTimeout(() => { btn.textContent = t('settings.slack.guide.copyManifest'); }, 2500);
        }
    });

    document.getElementById('slack-open-apps')?.addEventListener('click', () => {
        window.open('https://api.slack.com/apps?new_app=1', '_blank', 'noopener');
    });

    bindPrefixValidation('slBotToken', 'slack-bot-token-error', hasSlackBotTokenPrefix);
    bindPrefixValidation('slAppToken', 'slack-app-token-error', hasSlackAppTokenPrefix);
}

function bindPrefixValidation(inputId: string, errorId: string, valid: (v: string) => boolean): void {
    const input = document.getElementById(inputId) as HTMLInputElement | null;
    const error = document.getElementById(errorId);
    if (!input || !error) return;
    const check = (): void => {
        const bad = input.value.trim().length > 0 && !valid(input.value);
        error.style.display = bad ? '' : 'none';
        input.classList.toggle('input-error', bad);
    };
    // On blur only until the first error appears; then live, so correcting
    // the paste clears the error immediately.
    input.addEventListener('blur', check);
    input.addEventListener('input', () => {
        if (error.style.display !== 'none') check();
    });
}

export async function saveSlackSettings(): Promise<void> {
    const botToken = (document.getElementById('slBotToken') as HTMLInputElement)?.value.trim() || '';
    const appToken = (document.getElementById('slAppToken') as HTMLInputElement)?.value.trim() || '';
    const teamId = (document.getElementById('slTeamId') as HTMLInputElement)?.value.trim() || '';
    const channelIdsRaw = (document.getElementById('slChannelIds') as HTMLInputElement)?.value.trim() || '';
    const channelIds = channelIdsRaw
        ? channelIdsRaw.split(',').map(s => s.trim()).filter(Boolean)
        : [];
    await apiJson('/api/settings', 'PUT', { slack: { botToken, appToken, teamId, channelIds } });
}

export async function setSlack(enabled: boolean): Promise<void> {
    document.getElementById('slOn')?.classList.toggle('active', enabled);
    document.getElementById('slOff')?.classList.toggle('active', !enabled);
    await apiJson('/api/settings', 'PUT', { slack: { enabled } });
    if (enabled) openSetupGuideIfUnconfigured('slack');
}

export async function setSlackForwardAll(enabled: boolean): Promise<void> {
    document.getElementById('slForwardOn')?.classList.toggle('active', enabled);
    document.getElementById('slForwardOff')?.classList.toggle('active', !enabled);
    await apiJson('/api/settings', 'PUT', { slack: { forwardAll: enabled } });
}

export async function setSlackAllowBots(allow: boolean): Promise<void> {
    document.getElementById('slAllowBotsOn')?.classList.toggle('active', allow);
    document.getElementById('slAllowBotsOff')?.classList.toggle('active', !allow);
    await apiJson('/api/settings', 'PUT', { slack: { allowBots: allow } });
}

export async function setSlackMentionOnly(enabled: boolean): Promise<void> {
    document.getElementById('slMentionOn')?.classList.toggle('active', enabled);
    document.getElementById('slMentionOff')?.classList.toggle('active', !enabled);
    await apiJson('/api/settings', 'PUT', { slack: { mentionOnly: enabled } });
}

export async function setSlackReplyInThread(enabled: boolean): Promise<void> {
    document.getElementById('slThreadOn')?.classList.toggle('active', enabled);
    document.getElementById('slThreadOff')?.classList.toggle('active', !enabled);
    await apiJson('/api/settings', 'PUT', { slack: { replyInThread: enabled } });
}

export function loadSlackSettings(s: SettingsData): void {
    if (!s.slack) return;
    const sc = s.slack;
    document.getElementById('slOn')?.classList.toggle('active', !!sc.enabled);
    document.getElementById('slOff')?.classList.toggle('active', !sc.enabled);
    const botToken = document.getElementById('slBotToken') as HTMLInputElement | null;
    if (sc.botToken && botToken) botToken.value = sc.botToken;
    const appToken = document.getElementById('slAppToken') as HTMLInputElement | null;
    if (sc.appToken && appToken) appToken.value = sc.appToken;
    const teamId = document.getElementById('slTeamId') as HTMLInputElement | null;
    if (sc.teamId && teamId) teamId.value = sc.teamId;
    const channelIds = document.getElementById('slChannelIds') as HTMLInputElement | null;
    if (sc.channelIds?.length && channelIds) channelIds.value = sc.channelIds.join(', ');
    const fwdOn = sc.forwardAll !== false;
    document.getElementById('slForwardOn')?.classList.toggle('active', fwdOn);
    document.getElementById('slForwardOff')?.classList.toggle('active', !fwdOn);
    const allowBots = !!sc.allowBots;
    document.getElementById('slAllowBotsOn')?.classList.toggle('active', allowBots);
    document.getElementById('slAllowBotsOff')?.classList.toggle('active', !allowBots);
    // mentionOnly and replyInThread default TRUE for Slack (unlike Discord's
    // mentionOnly), so a `!!` read would show the toggle off on a fresh
    // install while the backend behaves as on.
    const mentionOnly = sc.mentionOnly !== false;
    document.getElementById('slMentionOn')?.classList.toggle('active', mentionOnly);
    document.getElementById('slMentionOff')?.classList.toggle('active', !mentionOnly);
    const replyInThread = sc.replyInThread !== false;
    document.getElementById('slThreadOn')?.classList.toggle('active', replyInThread);
    document.getElementById('slThreadOff')?.classList.toggle('active', !replyInThread);
}
