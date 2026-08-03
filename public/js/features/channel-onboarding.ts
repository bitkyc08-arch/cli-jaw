// ── Channel Onboarding Wizard ──
// One modal, all three channels: guide (where each token is issued) →
// paste token(s) → live-validate via POST /api/channels/validate → save
// through PUT /api/settings (hot transport restart included). Opened by the
// "연결" button in each channel section and by the unconfigured-activation
// guard in channel-setup-guide.ts. No emoji as UI elements (STRICT).
import { api, apiJson } from '../api.js';
import { t } from './i18n.js';
import { refreshTransportStatusRow } from './transport-status-row.js';

export type OnboardChannel = 'telegram' | 'discord' | 'slack';

type FieldDef = { key: string; id: string; secret: boolean; optional?: boolean };

const FIELDS: Record<OnboardChannel, FieldDef[]> = {
    telegram: [{ key: 'botToken', id: 'tgToken', secret: true }],
    discord: [
        { key: 'botToken', id: 'dcToken', secret: true },
        { key: 'guildId', id: 'dcGuildId', secret: false },
    ],
    slack: [
        { key: 'botToken', id: 'slBotToken', secret: true },
        { key: 'appToken', id: 'slAppToken', secret: true, optional: true },
    ],
};

let overlay: HTMLDivElement | null = null;
let activeChannel: OnboardChannel = 'telegram';
let validatedIdentity: string | null = null;
let validatedTeamId = '';

export function initChannelOnboarding(): void {
    document.addEventListener('click', (ev) => {
        const btn = (ev.target as HTMLElement | null)?.closest('[data-onboard-channel]') as HTMLElement | null;
        if (!btn) return;
        ev.preventDefault();
        openChannelOnboarding(btn.getAttribute('data-onboard-channel') as OnboardChannel);
    });
}

export function openChannelOnboarding(channel: OnboardChannel): void {
    if (!FIELDS[channel]) return;
    activeChannel = channel;
    validatedIdentity = null;
    validatedTeamId = '';
    ensureOverlay();
    render('form');
    overlay?.classList.add('open');
}

function close(): void {
    overlay?.classList.remove('open');
}

function ensureOverlay(): void {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'modal-overlay onboarding-overlay';
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });
    document.body.appendChild(overlay);
}

function fieldValue(id: string): string {
    return (document.getElementById(id) as HTMLInputElement | null)?.value.trim() || '';
}

function setFieldValue(id: string, value: string): void {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.value = value;
}

function render(mode: 'form' | 'done', errorKey = ''): void {
    if (!overlay) return;
    const fields = FIELDS[activeChannel];
    // Re-renders (validation round-trips) must not wipe what the user typed:
    // prefer live modal inputs, fall back to the settings section inputs.
    const valueOf = (f: FieldDef, i: number): string =>
        (document.getElementById(`onboard-input-${i}`) as HTMLInputElement | null)?.value ?? fieldValue(f.id);
    const inputs = fields.map((f, i) => `
        <div class="onboarding-field">
            <label for="onboard-input-${i}">${t(`onboarding.token.${f.key}`)}${f.optional ? ` (${t('onboarding.optional')})` : ''}</label>
            <input id="onboard-input-${i}" class="input-sm" type="${f.secret ? 'password' : 'text'}"
                value="${valueOf(f, i).replace(/"/g, '&quot;')}">
        </div>`).join('');

    overlay.innerHTML = `
        <div class="modal-box onboarding-box" role="dialog" aria-modal="true">
            <div class="onboarding-head">
                <span class="onboarding-title">${t(`onboarding.title.${activeChannel}`)}</span>
                <button type="button" class="help-trigger onboarding-close" data-onboard-close="1">✕</button>
            </div>
            <p class="onboarding-guide">${t(`onboarding.guide.${activeChannel}`)}</p>
            ${mode === 'form' ? `
                ${inputs}
                <div class="onboarding-error" style="display:${errorKey ? '' : 'none'}">${errorKey ? t(`onboarding.error.${errorKey}`) : ''}</div>
                <div class="onboarding-identity" style="display:${validatedIdentity ? '' : 'none'}">
                    ${validatedIdentity ? t('onboarding.valid', { identity: validatedIdentity }) : ''}
                </div>
                <div class="onboarding-actions">
                    <button type="button" class="perm-btn" data-onboard-validate="1">${t('onboarding.validate')}</button>
                    <button type="button" class="perm-btn ${validatedIdentity ? 'active' : ''}" data-onboard-save="1">${t('onboarding.save')}</button>
                </div>` : `
                <p class="onboarding-next">${t(`onboarding.next.${activeChannel}`)}</p>
                <div class="onboarding-actions">
                    <button type="button" class="perm-btn active" data-onboard-close="1">${t('onboarding.close')}</button>
                </div>`}
        </div>`;

    overlay.querySelectorAll('[data-onboard-close]').forEach(b => b.addEventListener('click', close));
    overlay.querySelector('[data-onboard-validate]')?.addEventListener('click', () => { void runValidation(); });
    overlay.querySelector('[data-onboard-save]')?.addEventListener('click', () => { void runSave(); });
}

function readInputs(): Record<string, string> {
    const out: Record<string, string> = {};
    FIELDS[activeChannel].forEach((f, i) => {
        out[f.key] = (document.getElementById(`onboard-input-${i}`) as HTMLInputElement | null)?.value.trim() || '';
    });
    return out;
}

async function runValidation(): Promise<void> {
    const creds = readInputs();
    validatedIdentity = null;
    render('form', creds['botToken'] ? '' : 'token_required');
    if (!creds['botToken']) return;
    const res = await api<{ ok?: boolean; identity?: string; teamId?: string; error?: string }>(
        '/api/channels/validate',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: activeChannel, ...creds }) },
    );
    if (res?.ok) {
        validatedIdentity = res.identity || 'ok';
        validatedTeamId = res.teamId || '';
        render('form');
    } else {
        render('form', res?.error || 'network');
    }
}

async function runSave(): Promise<void> {
    const creds = readInputs();
    // Mirror the values into the settings section inputs so the existing
    // load/save surfaces stay consistent.
    FIELDS[activeChannel].forEach((f) => setFieldValue(f.id, creds[f.key] || ''));
    let patch: Record<string, unknown>;
    if (activeChannel === 'telegram') {
        patch = { telegram: { enabled: true, token: creds['botToken'] } };
    } else if (activeChannel === 'discord') {
        patch = { discord: { enabled: true, token: creds['botToken'], guildId: creds['guildId'] } };
    } else {
        patch = { slack: { enabled: true, botToken: creds['botToken'], appToken: creds['appToken'] || '', ...(validatedTeamId ? { teamId: validatedTeamId } : {}) } };
    }
    await apiJson('/api/settings', 'PUT', patch);
    render('done');
    void refreshTransportStatusRow();
}
