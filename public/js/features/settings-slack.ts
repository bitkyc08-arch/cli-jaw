// ── Slack Settings ──
import { API_BASE, api, apiJson, getAuthToken } from '../api.js';
import { openSetupGuideIfUnconfigured } from './channel-setup-guide.js';
import { hasSlackBotTokenPrefix, hasSlackAppTokenPrefix } from './channel-setup-rules.js';
import { t } from './i18n.js';
import { refreshTransportStatusRow } from './transport-status-row.js';
import type { SettingsData } from './settings-types.js';

// One-time inline token-prefix validation. Errors appear below each field on
// blur and clear live once the token prefix is corrected.
let setupGuideBound = false;
let slackResetting = false;
let slackEnvironmentVariables: string[] = [];

type SlackResetResponse = {
    ok?: boolean;
    error?: string;
    environmentVariables?: string[];
};

async function requestSlackConnectionReset(): Promise<SlackResetResponse | null> {
    try {
        const token = await getAuthToken();
        const response = await fetch(`${API_BASE}/api/settings/slack/reset`, {
            method: 'POST',
            headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        return await response.json().catch(() => null) as SlackResetResponse | null;
    } catch {
        // The write may have committed even if its response was lost. The
        // authoritative GET below decides whether the reset actually landed.
        return null;
    }
}

function slackConnectionIsCleared(snapshot: SettingsData | null): boolean {
    const slack = snapshot?.slack;
    return !slack?.enabled
        && !slack?.botToken
        && !slack?.appToken
        && !slack?.teamId
        && !(slack?.channelIds?.length)
        && !slack?.attachPort;
}

function slackEnvironmentMessage(): string {
    return t('settings.slack.resetManagedByEnvironment', {
        variables: slackEnvironmentVariables.join(', ') || 'SLACK_*',
    });
}

export function initSlackSetupGuide(): void {
    if (setupGuideBound) return;
    setupGuideBound = true;

    bindPrefixValidation('slBotToken', 'slack-bot-token-error', hasSlackBotTokenPrefix);
    bindPrefixValidation('slAppToken', 'slack-app-token-error', hasSlackAppTokenPrefix);
    document.getElementById('slack-reset-connection')?.addEventListener('click', () => {
        void resetSlackConnection();
    });
}

export async function resetSlackConnection(): Promise<void> {
    if (slackResetting) return;
    if (slackEnvironmentVariables.length > 0) {
        window.alert(slackEnvironmentMessage());
        return;
    }
    const botToken = document.getElementById('slBotToken') as HTMLInputElement | null;
    const appToken = document.getElementById('slAppToken') as HTMLInputElement | null;
    if (!botToken?.value.trim() && !appToken?.value.trim()) {
        window.alert(t('settings.slack.resetEmpty'));
        return;
    }
    if (!window.confirm(t('settings.slack.resetConfirm'))) return;

    const resetButton = document.getElementById('slack-reset-connection') as HTMLButtonElement | null;
    slackResetting = true;
    if (resetButton) resetButton.disabled = true;
    try {
        const result = await requestSlackConnectionReset();
        const authoritative = await api<SettingsData>('/api/settings');
        if (authoritative) loadSlackSettings(authoritative);
        await refreshTransportStatusRow();

        if (result?.error === 'slack_connection_managed_by_environment') {
            const variables = Array.isArray(result.environmentVariables)
                ? result.environmentVariables.join(', ')
                : 'SLACK_*';
            window.alert(t('settings.slack.resetManagedByEnvironment', { variables }));
            return;
        }
        if (!slackConnectionIsCleared(authoritative)) {
            window.alert(t('settings.slack.resetFailed'));
            return;
        }

        for (const id of ['slBotToken', 'slAppToken', 'slTeamId', 'slChannelIds', 'slAttachPort']) {
            document.getElementById(id)?.classList.remove('input-error');
        }
        for (const id of ['slack-bot-token-error', 'slack-app-token-error']) {
            const error = document.getElementById(id);
            if (error) error.style.display = 'none';
        }
        document.getElementById('slOff')?.classList.add('active');
        document.getElementById('slOn')?.classList.remove('active');
    } finally {
        slackResetting = false;
        if (resetButton) resetButton.disabled = slackEnvironmentVariables.length > 0;
    }
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
    if (slackEnvironmentVariables.length > 0) {
        window.alert(slackEnvironmentMessage());
        return;
    }
    const botToken = (document.getElementById('slBotToken') as HTMLInputElement)?.value.trim() || '';
    const appToken = (document.getElementById('slAppToken') as HTMLInputElement)?.value.trim() || '';
    const teamId = (document.getElementById('slTeamId') as HTMLInputElement)?.value.trim() || '';
    const channelIdsRaw = (document.getElementById('slChannelIds') as HTMLInputElement)?.value.trim() || '';
    const attachPort = (document.getElementById('slAttachPort') as HTMLInputElement)?.value.trim() || '';
    const channelIds = channelIdsRaw
        ? channelIdsRaw.split(',').map(s => s.trim()).filter(Boolean)
        : [];
    await apiJson('/api/settings', 'PUT', { slack: { botToken, appToken, teamId, channelIds, attachPort } });
}

export async function setSlack(enabled: boolean): Promise<void> {
    if (slackEnvironmentVariables.length > 0) {
        window.alert(slackEnvironmentMessage());
        return;
    }
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
    slackEnvironmentVariables = Array.isArray(s.slackEnvironmentVariables)
        ? s.slackEnvironmentVariables
        : [];
    const environmentManaged = slackEnvironmentVariables.length > 0;
    const notice = document.getElementById('slack-environment-managed');
    if (notice) {
        notice.style.display = environmentManaged ? '' : 'none';
        notice.textContent = environmentManaged
            ? t('settings.slack.managedByEnvironment', { variables: slackEnvironmentVariables.join(', ') })
            : '';
    }
    for (const id of ['slBotToken', 'slAppToken', 'slTeamId', 'slChannelIds', 'slAttachPort']) {
        const input = document.getElementById(id) as HTMLInputElement | null;
        if (input) input.disabled = environmentManaged;
    }
    for (const id of ['slOff', 'slOn', 'slack-reset-connection', 'slack-onboarding-trigger']) {
        const button = document.getElementById(id) as HTMLButtonElement | null;
        if (button) button.disabled = environmentManaged;
    }
    document.getElementById('slOn')?.classList.toggle('active', !!sc.enabled);
    document.getElementById('slOff')?.classList.toggle('active', !sc.enabled);
    const botToken = document.getElementById('slBotToken') as HTMLInputElement | null;
    if (botToken) botToken.value = environmentManaged ? '' : sc.botToken || '';
    const appToken = document.getElementById('slAppToken') as HTMLInputElement | null;
    if (appToken) appToken.value = environmentManaged ? '' : sc.appToken || '';
    const teamId = document.getElementById('slTeamId') as HTMLInputElement | null;
    if (teamId) teamId.value = environmentManaged ? '' : sc.teamId || '';
    const channelIds = document.getElementById('slChannelIds') as HTMLInputElement | null;
    if (channelIds) channelIds.value = environmentManaged ? '' : sc.channelIds?.join(', ') || '';
    const attachPort = document.getElementById('slAttachPort') as HTMLInputElement | null;
    if (attachPort) attachPort.value = environmentManaged ? '' : sc.attachPort || '';
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
