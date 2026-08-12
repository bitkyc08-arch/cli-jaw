// ── Channel Onboarding Wizard (UI shell) ──
// Four numbered steps for every channel: 안내 → 자격 증명 입력 → 연결 검증 →
// 저장. Each step is gated by channel-onboarding-flow.ts, so "다음" refuses to
// move while that step's own contract is unmet, and draft values survive
// moving back and forth. This module owns rendering and IO only.
import { api, apiJson } from '../api.js';
import { t } from './i18n.js';
import { escapeHtml } from '../render.js';
import { refreshTransportStatusRow } from './transport-status-row.js';
import {
    TOTAL_STEPS,
    ISSUER_URLS,
    advance,
    applyValidation,
    blockerForStep,
    canAdvance,
    createFlow,
    fieldsFor,
    goBack,
    markSlackIssuerOpened,
    markSlackManifestGenerated,
    markSaved,
    resetSlackSetup,
    setField,
    settingsPatch,
    validationPayload,
    type FlowState,
    type OnboardChannel,
} from './channel-onboarding-flow.js';
import { maybeRequestNotificationPermission } from './notifications.js';
import { copyText } from './copy-text.js';

export type { OnboardChannel };

let overlay: HTMLDivElement | null = null;
let flow: FlowState | null = null;
let validating = false;
let saving = false;
let slackAppName = 'cli-jaw';
/**
 * Bumped whenever the wizard is (re)opened. An in-flight validation compares
 * it on return: switching to another channel — or reopening the same one —
 * must not let a stale response mark the new flow as verified.
 */
let flowGeneration = 0;

export function initChannelOnboarding(): void {
    document.addEventListener('click', (ev) => {
        const btn = (ev.target as HTMLElement | null)?.closest('[data-onboard-channel]') as HTMLElement | null;
        if (!btn) return;
        ev.preventDefault();
        openChannelOnboarding(btn.getAttribute('data-onboard-channel') as OnboardChannel);
    });
    // Capture phase, matching help-dialog: whichever overlay is open handles
    // Escape and stops it there, so the two never both react.
    document.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Escape' || !flow) return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
        close();
    }, true);
    // Focus trap: a modal that lets Tab wander into the page behind it is a
    // keyboard dead end — the user cannot see what is focused and cannot get
    // back without a mouse.
    document.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Tab' || !flow || !overlay) return;
        const focusable = [...overlay.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        )];
        if (!focusable.length) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        const active = document.activeElement as HTMLElement | null;
        if (ev.shiftKey && (active === first || !overlay.contains(active))) {
            ev.preventDefault();
            last.focus();
        } else if (!ev.shiftKey && active === last) {
            ev.preventDefault();
            first.focus();
        }
    }, true);
}

export function openChannelOnboarding(channel: OnboardChannel): void {
    if (channel !== 'telegram' && channel !== 'discord' && channel !== 'slack') return;
    // Seed the draft from whatever the settings section already holds, so an
    // existing token does not have to be retyped.
    const draft: Record<string, string> = {};
    for (const field of fieldsFor(channel)) {
        draft[field.key] = readSettingsInput(field.settingsId);
    }
    flow = createFlow(channel, draft);
    if (channel === 'slack') slackAppName = 'cli-jaw';
    validating = false;
    saving = false;
    flowGeneration += 1;
    ensureOverlay();
    render();
    overlay?.classList.add('open');
}

function close(): void {
    overlay?.classList.remove('open');
    flow = null;
}

function readSettingsInput(id: string): string {
    return (document.getElementById(id) as HTMLInputElement | null)?.value.trim() || '';
}

function writeSettingsInput(id: string, value: string): void {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.value = value;
}

function ensureOverlay(): void {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'modal-overlay onboarding-overlay';
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });
    document.body.appendChild(overlay);
}

function stepBody(state: FlowState): string {
    if (state.step === 1) {
        const slackStage = state.slackSetupStage;
        const slackManifestBuilder = state.channel === 'slack' ? `
            <div class="onboarding-field">
                <label for="onboard-slack-app-name">${escapeHtml(t('onboarding.slackAppName'))}</label>
                <input id="onboard-slack-app-name" data-onboard-app-name="1" class="input-sm"
                    type="text" autocomplete="off"
                    spellcheck="false"
                    aria-describedby="onboard-slack-app-name-hint onboard-slack-manifest-status"
                    value="${escapeHtml(slackAppName)}">
                <span class="onboarding-hint" id="onboard-slack-app-name-hint">${escapeHtml(t('onboarding.slackAppNameHint'))}</span>
            </div>
            <div class="onboarding-actions">
                <button type="button" class="perm-btn ${slackStage === 'manifest' ? 'active' : ''}" data-onboard-generate-manifest="1">
                    ${escapeHtml(t('onboarding.slackGenerateManifest'))}
                </button>
                <span class="onboarding-manifest-status" id="onboard-slack-manifest-status"
                    data-onboard-manifest-status="1" role="status" aria-live="polite"></span>
            </div>` : '';
        return `
            ${slackManifestBuilder}
            <p class="onboarding-guide">${escapeHtml(t(`onboarding.guide.${state.channel}`))}</p>
            <div class="onboarding-actions">
                <button type="button" class="perm-btn ${state.channel === 'slack' && slackStage === 'issuer' ? 'active' : ''}"
                    data-onboard-issuer="1" ${state.channel === 'slack' && slackStage === 'manifest' ? 'disabled' : ''}>
                    ${escapeHtml(t('onboarding.openIssuer'))}
                </button>
            </div>`;
    }
    if (state.step === 2) {
        const fields = fieldsFor(state.channel).map((field) => {
            const label = t(`onboarding.token.${field.key}`) + (field.optional ? ` (${t('onboarding.optional')})` : '');
            return `
            <div class="onboarding-field">
                <label for="onboard-${field.key}">${escapeHtml(label)}</label>
                <input id="onboard-${field.key}" data-onboard-field="${field.key}" class="input-sm"
                    type="${field.secret ? 'password' : 'text'}"
                    placeholder="${escapeHtml(field.example)}"
                    autocomplete="off" spellcheck="false"
                    value="${escapeHtml(state.draft[field.key] || '')}">
                <span class="onboarding-hint">${escapeHtml(t(`onboarding.hint.${state.channel}.${field.key}`))}</span>
            </div>`;
        }).join('');
        return fields;
    }
    if (state.step === 3) {
        const status = validating
            ? `<p class="onboarding-guide">${escapeHtml(t('onboarding.validating'))}</p>`
            : state.validatedIdentity
                ? `<p class="onboarding-identity">${escapeHtml(t('onboarding.valid', { identity: state.validatedIdentity }))}</p>`
                : `<p class="onboarding-guide">${escapeHtml(t('onboarding.validateHint'))}</p>`;
        return `${status}
            <div class="onboarding-actions">
                <button type="button" class="perm-btn" data-onboard-validate="1" ${validating ? 'disabled' : ''}>
                    ${escapeHtml(t('onboarding.validate'))}
                </button>
            </div>`;
    }
    return `<p class="onboarding-next">${escapeHtml(t(
        state.saved ? `onboarding.next.${state.channel}` : 'onboarding.saveHint',
    ))}</p>`;
}

function footer(state: FlowState): string {
    if (state.step === TOTAL_STEPS && state.saved) {
        return `<button type="button" class="perm-btn active" data-onboard-close="1">${escapeHtml(t('onboarding.close'))}</button>`;
    }
    const back = state.step > 1
        ? `<button type="button" class="perm-btn" data-onboard-back="1">${escapeHtml(t('onboarding.back'))}</button>`
        : '';
    const primary = state.step === TOTAL_STEPS
        ? `<button type="button" class="perm-btn active" data-onboard-save="1">${escapeHtml(t('onboarding.save'))}</button>`
        : `<button type="button" class="perm-btn ${canAdvance(state) ? 'active' : ''}" data-onboard-next="1"
            ${state.channel === 'slack' && state.step === 1 && !canAdvance(state) ? 'disabled' : ''}>${escapeHtml(t('onboarding.next'))}</button>`;
    return `${back}${primary}`;
}

function render(): void {
    if (!overlay || !flow) return;
    const state = flow;
    overlay.innerHTML = `
        <div class="modal-box onboarding-box" role="dialog" aria-modal="true"
            aria-labelledby="onboarding-title" aria-describedby="onboarding-step-title">
            <div class="onboarding-head">
                <span class="onboarding-title" id="onboarding-title">${escapeHtml(t(`onboarding.title.${state.channel}`))}</span>
                <span class="onboarding-progress" role="status" aria-live="polite"
                    aria-label="${escapeHtml(t('onboarding.progressLabel', { step: state.step, total: TOTAL_STEPS }))}">${state.step}/${TOTAL_STEPS}</span>
                <button type="button" class="help-trigger onboarding-close" data-onboard-close="1"
                    aria-label="${escapeHtml(t('onboarding.close'))}">✕</button>
            </div>
            <div class="onboarding-steps" aria-hidden="true">
                ${Array.from({ length: TOTAL_STEPS }, (_, i) =>
                    `<span class="onboarding-dot${i + 1 === state.step ? ' is-active' : ''}${i + 1 < state.step ? ' is-done' : ''}"></span>`).join('')}
            </div>
            <div class="onboarding-step-title" id="onboarding-step-title">${escapeHtml(t(`onboarding.step.${state.step}`))}</div>
            ${stepBody(state)}
            <div class="onboarding-error" role="alert" style="display:${state.error ? '' : 'none'}">
                ${state.error ? escapeHtml(t(`onboarding.error.${state.error}`)) : ''}
                ${state.missingScopes.length ? `<span class="onboarding-scopes">${escapeHtml(state.missingScopes.join(', '))}</span>` : ''}
            </div>
            <div class="onboarding-capability-warning" role="status" style="display:${state.missingCapabilities.length ? '' : 'none'}">
                ${state.missingCapabilities.length
                    ? escapeHtml(t('onboarding.warning.missingCapabilities', {
                        capabilities: state.missingCapabilities.join(', '),
                    }))
                    : ''}
            </div>
            <div class="onboarding-actions onboarding-footer">${footer(state)}</div>
        </div>`;

    overlay.querySelectorAll('[data-onboard-close]').forEach(el => el.addEventListener('click', close));
    overlay.querySelector('[data-onboard-issuer]')?.addEventListener('click', () => {
        if (!flow) return;
        window.open(ISSUER_URLS[flow.channel], '_blank', 'noopener');
        if (flow.channel === 'slack') {
            flow = markSlackIssuerOpened(flow);
            syncSlackStepActions();
        }
    });
    overlay.querySelector('[data-onboard-generate-manifest]')?.addEventListener('click', () => {
        void runSlackManifestGeneration();
    });
    overlay.querySelector('[data-onboard-app-name]')?.addEventListener('input', (ev) => {
        slackAppName = (ev.currentTarget as HTMLInputElement).value;
        if (flow?.channel === 'slack') flow = resetSlackSetup(flow);
        const status = overlay?.querySelector<HTMLElement>('[data-onboard-manifest-status]');
        status?.classList.remove('is-error');
        if (status) status.textContent = '';
        syncSlackStepActions();
    });
    overlay.querySelector('[data-onboard-app-name]')?.addEventListener('keydown', (ev) => {
        const keyEvent = ev as KeyboardEvent;
        if (keyEvent.key !== 'Enter' || keyEvent.shiftKey || keyEvent.isComposing) return;
        keyEvent.preventDefault();
        void runSlackManifestGeneration();
    });
    overlay.querySelector('[data-onboard-back]')?.addEventListener('click', () => {
        if (!flow) return;
        flow = goBack(flow);
        render();
    });
    overlay.querySelector('[data-onboard-next]')?.addEventListener('click', () => {
        if (!flow) return;
        captureInputs();
        flow = advance(flow);
        render();
    });
    overlay.querySelector('[data-onboard-validate]')?.addEventListener('click', () => { void runValidation(); });
    overlay.querySelector('[data-onboard-save]')?.addEventListener('click', () => { void runSave(); });
    // Live capture keeps the draft authoritative even if the user closes the
    // step without pressing 다음.
    overlay.querySelectorAll('[data-onboard-field]').forEach(el => {
        el.addEventListener('input', () => {
            if (!flow) return;
            const key = (el as HTMLElement).getAttribute('data-onboard-field') || '';
            flow = setField(flow, key, (el as HTMLInputElement).value);
        });
        // Enter submits the step instead of doing nothing — the wizard is a
        // form, and a form that ignores Enter reads as broken.
        el.addEventListener('keydown', (ev) => {
            const key = (ev as KeyboardEvent).key;
            if (key !== 'Enter' || (ev as KeyboardEvent).shiftKey || (ev as KeyboardEvent).isComposing) return;
            ev.preventDefault();
            primaryAction();
        });
    });

    focusFirstEmptyField();
}

function syncSlackStepActions(): void {
    if (!overlay || flow?.channel !== 'slack' || flow.step !== 1) return;
    const stage = flow.slackSetupStage;
    const manifest = overlay.querySelector<HTMLButtonElement>('[data-onboard-generate-manifest]');
    const issuer = overlay.querySelector<HTMLButtonElement>('[data-onboard-issuer]');
    const next = overlay.querySelector<HTMLButtonElement>('[data-onboard-next]');

    manifest?.classList.toggle('active', stage === 'manifest');
    issuer?.classList.toggle('active', stage === 'issuer');
    if (issuer) issuer.disabled = stage === 'manifest';
    next?.classList.toggle('active', stage === 'ready');
    if (next) next.disabled = stage !== 'ready';
}

/** Whatever the current step's primary button does — Enter mirrors it. */
function primaryAction(): void {
    if (!flow) return;
    if (flow.step === 3) { void runValidation(); return; }
    if (flow.step === TOTAL_STEPS) { if (!flow.saved) void runSave(); return; }
    captureInputs();
    flow = advance(flow);
    render();
}

/**
 * render() replaces innerHTML, so focus is lost on every state change. Restore
 * it to the first field still needing input (or the first field at all), which
 * is also what a freshly opened step-2 should focus.
 */
function focusFirstEmptyField(): void {
    const inputs = [...(overlay?.querySelectorAll('[data-onboard-app-name], [data-onboard-field]') ?? [])] as HTMLInputElement[];
    if (!inputs.length) return;
    const target = inputs.find(input => !input.value.trim()) ?? inputs[0];
    target?.focus();
    // Caret at the end so an existing value can be corrected, not overwritten.
    const end = target?.value.length ?? 0;
    target?.setSelectionRange?.(end, end);
}

async function runSlackManifestGeneration(): Promise<void> {
    if (!overlay || flow?.channel !== 'slack') return;
    const generation = flowGeneration;
    const input = overlay.querySelector<HTMLInputElement>('[data-onboard-app-name]');
    const button = overlay.querySelector<HTMLButtonElement>('[data-onboard-generate-manifest]');
    const status = overlay.querySelector<HTMLElement>('[data-onboard-manifest-status]');
    if (!input || !button || !status) return;

    const appName = input.value.trim();
    slackAppName = appName;
    if (!appName || Array.from(appName).length > 35) {
        status.classList.add('is-error');
        status.textContent = t('onboarding.slackAppNameError');
        input.focus();
        return;
    }

    status.classList.remove('is-error');
    status.textContent = '';
    button.disabled = true;
    button.textContent = t('onboarding.slackManifestGenerating');

    try {
        const data = await api<{ json?: string; botDisplayName?: string }>(`/api/slack/manifest?name=${encodeURIComponent(appName)}`);
        if (generation !== flowGeneration || flow?.channel !== 'slack' || slackAppName.trim() !== appName) return;
        const json = data?.json || '';
        if (!json) throw new Error('empty manifest');
        const copied = await copyText(json);
        if (!copied.ok) throw new Error(copied.error || 'copy failed');
        if (generation !== flowGeneration || flow?.channel !== 'slack' || slackAppName.trim() !== appName) return;
        flow = markSlackManifestGenerated(flow);
        const botName = data?.botDisplayName;
        status.textContent = botName && botName !== appName
            ? t('onboarding.slackManifestCopiedWithBot', { bot: botName })
            : t('onboarding.slackManifestReady');
        syncSlackStepActions();
    } catch {
        status.classList.add('is-error');
        status.textContent = t('onboarding.slackManifestError');
    } finally {
        button.disabled = false;
        button.textContent = t('onboarding.slackGenerateManifest');
        syncSlackStepActions();
    }
}

function captureInputs(): void {
    if (!flow) return;
    for (const el of overlay?.querySelectorAll('[data-onboard-field]') ?? []) {
        const key = el.getAttribute('data-onboard-field') || '';
        flow = setField(flow, key, (el as HTMLInputElement).value);
    }
}

async function runValidation(): Promise<void> {
    if (!flow || validating) return;
    const generation = flowGeneration;
    validating = true;
    render();
    const res = await api<{
        ok?: boolean;
        identity?: string;
        teamId?: string;
        error?: string;
        missing?: string[];
        missingCapabilities?: string[];
    }>(
        '/api/channels/validate',
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(validationPayload(flow)),
        },
    );
    // The wizard may have been closed or pointed at another channel while the
    // request was in flight; applying this result then would verify the wrong
    // credentials.
    if (generation !== flowGeneration) return;
    validating = false;
    if (!flow) return;
    flow = applyValidation(flow, res || { ok: false, error: 'network' });
    render();
}

async function runSave(): Promise<void> {
    if (!flow || saving) return;
    const blocker = blockerForStep({ ...flow, step: 3 });
    if (blocker) {
        flow = { ...flow, step: 3, error: blocker };
        render();
        return;
    }
    // Mirror into the settings section so the existing load/save surfaces and
    // the transport status row stay consistent with the wizard.
    for (const field of fieldsFor(flow.channel)) {
        writeSettingsInput(field.settingsId, (flow.draft[field.key] || '').trim());
    }
    const generation = flowGeneration;
    saving = true;
    try {
        await apiJson('/api/settings', 'PUT', settingsPatch(flow));
    } finally {
        saving = false;
    }
    if (generation !== flowGeneration || !flow) return;
    flow = markSaved(flow);
    render();
    void refreshTransportStatusRow();
    // The save click is a user gesture, which is the only moment a browser
    // will honour a notification request — and the only moment it is relevant,
    // since a channel just started delivering messages.
    void maybeRequestNotificationPermission();
}
