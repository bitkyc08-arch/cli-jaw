// ChatGPT Work surface picker + submit + poll (parity2 8b, catalog C-02/B1).
//
// Ported core of agbrowse web-ai/chatgpt-work-picker.mjs (1,246 lines): the
// Power 1..6 mapping, input normalizers, picker state read, ensureWorkSurface,
// keyboard-driven setWorkPower, button-only submitWorkPrompt with commit
// verification, main-region-scoped readWorkTaskState (tri-state stop probe,
// unknown fails closed), and the reattach guards. Live-DOM selectors mirror
// the 2026-07-10 smoke contract (aria-hidden Radix thumb; Power menuitem is
// the keyboard target).

import { WebAiError } from './errors.js';
import { detectChatGptComposerSurface } from './product-surfaces.js';
import { probeStopButton, scopeToMainRegion } from './chatgpt-response-dom.js';

type WorkAnyPage = any;

export interface PowerMapping {
    power: number;
    domValue: number;
    compactLabel: string;
    model: string;
    effort: string;
}

export const WORK_POWER_MAP: readonly PowerMapping[] = Object.freeze([
    { power: 1, domValue: 0, compactLabel: '5.6 Terra Light', model: 'GPT-5.6 Terra', effort: 'Light' },
    { power: 2, domValue: 1, compactLabel: '5.6 Sol Light', model: 'GPT-5.6 Sol', effort: 'Light' },
    { power: 3, domValue: 2, compactLabel: '5.6 Sol Medium', model: 'GPT-5.6 Sol', effort: 'Medium' },
    { power: 4, domValue: 3, compactLabel: '5.6 Sol High', model: 'GPT-5.6 Sol', effort: 'High' },
    { power: 5, domValue: 4, compactLabel: '5.6 Sol Extra High', model: 'GPT-5.6 Sol', effort: 'Extra High' },
    { power: 6, domValue: 5, compactLabel: '5.6 Sol Ultra', model: 'GPT-5.6 Sol', effort: 'Ultra' },
]);

const WORK_SIMPLE_VIEW_SELECTOR = '[data-testid="composer-model-picker-slider-simple-view"]';
const WORK_ADVANCED_VIEW_SELECTOR = '[data-testid="composer-model-picker-slider-advanced-view"]';
const WORK_SLIDER_SELECTOR = `${WORK_SIMPLE_VIEW_SELECTOR} [role="slider"]`;
const WORK_POWER_CONTROL_SELECTOR = '[role="menuitem"][aria-label="Power"]';
const WORK_FAST_CHECKBOX_SELECTOR = '[role="menuitemcheckbox"][aria-label*="fast mode" i]';
const WORK_SEND_BUTTON_SELECTOR = 'form button[data-testid="send-button"]';
const CONVERSATION_TURN_SELECTOR = 'article[data-testid^="conversation-turn"], div[data-testid^="conversation-turn"]';
const WORK_COMMIT_TIMEOUT_MS = 30_000;

/** Validate and normalize a public Power integer (1..6). Rejects before any browser mutation. */
export function normalizeWorkPower(input: unknown): PowerMapping {
    const n = Number(input);
    if (!Number.isInteger(n) || n < 1 || n > 6) {
        throw new WebAiError({
            errorCode: 'internal.unhandled',
            stage: 'provider-work-preflight',
            message: `Power must be an integer 1..6, got: ${JSON.stringify(input)}`,
            retryHint: 'fix-power',
        });
    }
    return WORK_POWER_MAP[n - 1]!;
}

/** Normalize speed input. Unspecified means no speed mutation. */
export function normalizeWorkSpeed(input: unknown): 'standard' | 'fast' | null {
    if (input == null || input === '') return null;
    const key = String(input).trim().toLowerCase();
    if (key === 'standard' || key === 'fast') return key;
    throw new WebAiError({
        errorCode: 'internal.unhandled',
        stage: 'provider-work-preflight',
        message: `Speed must be 'standard' or 'fast', got: ${JSON.stringify(input)}`,
        retryHint: 'retry-speed',
    });
}

export interface WorkPickerState {
    power: number | null;
    domValue: number | null;
    domMin: number | null;
    domMax: number | null;
    valueText: string | null;
    compactLabel: string | null;
    model: string | null;
    effort: string | null;
    speed: string | null;
    fastChecked: boolean | null;
    simpleViewVisible: boolean;
    advancedViewVisible: boolean;
}

/** Read the current Work picker state from the DOM without mutations. */
export async function readWorkPickerState(page: WorkAnyPage): Promise<WorkPickerState> {
    const simpleVisible = await page.locator(WORK_SIMPLE_VIEW_SELECTOR).first().isVisible().catch(() => false);
    const advancedVisible = await page.locator(WORK_ADVANCED_VIEW_SELECTOR).first().isVisible().catch(() => false);
    const slider = page.locator(WORK_SLIDER_SELECTOR).first();
    // The live 5.6 thumb is aria-hidden (visibility checks lie); presence in
    // the simple view plus readable attributes is the observation contract.
    const sliderPresent = (await page.locator(WORK_SLIDER_SELECTOR).count().catch(() => 0)) > 0;

    let domValue: number | null = null;
    let domMin: number | null = null;
    let domMax: number | null = null;
    let valueText: string | null = null;
    if (sliderPresent) {
        const nowStr = await slider.getAttribute('aria-valuenow').catch(() => null);
        const minStr = await slider.getAttribute('aria-valuemin').catch(() => null);
        const maxStr = await slider.getAttribute('aria-valuemax').catch(() => null);
        valueText = await slider.getAttribute('aria-valuetext').catch(() => null);
        domValue = nowStr != null ? Number(nowStr) : null;
        domMin = minStr != null ? Number(minStr) : null;
        domMax = maxStr != null ? Number(maxStr) : null;
    }
    const power = domValue != null ? domValue + 1 : null;
    const compactLabel = valueText ? valueText.replace(/,\s*\d+\s+of\s+\d+\.?$/, '').trim() : null;

    let model: string | null = null;
    let effort: string | null = null;
    let speed: string | null = null;
    if (advancedVisible) {
        const modelLabel = await page.locator('[role="menuitem"][aria-label^="Model"]').first().getAttribute('aria-label').catch(() => null);
        const effortLabel = await page.locator('[role="menuitem"][aria-label^="Effort"]').first().getAttribute('aria-label').catch(() => null);
        const speedLabel = await page.locator('[role="menuitem"][aria-label^="Speed"]').first().getAttribute('aria-label').catch(() => null);
        model = modelLabel ? modelLabel.replace(/^Model\s*/i, '').trim() : null;
        effort = effortLabel ? effortLabel.replace(/^Effort\s*/i, '').trim() : null;
        speed = speedLabel ? speedLabel.replace(/^Speed\s*/i, '').trim().toLowerCase() : null;
    }
    const fastEl = page.locator(WORK_FAST_CHECKBOX_SELECTOR).first();
    const fastVisible = await fastEl.isVisible().catch(() => false);
    let fastChecked: boolean | null = null;
    if (fastVisible) {
        const checkedStr = await fastEl.getAttribute('aria-checked').catch(() => null);
        fastChecked = checkedStr === 'true';
    }
    if (speed == null && fastChecked != null) speed = fastChecked ? 'fast' : 'standard';
    if (power != null && model == null) {
        const mapping = WORK_POWER_MAP[power - 1];
        if (mapping) {
            model = model || mapping.model;
            effort = effort || mapping.effort;
        }
    }
    return { power, domValue, domMin, domMax, valueText, compactLabel, model, effort, speed, fastChecked, simpleViewVisible: simpleVisible, advancedViewVisible: advancedVisible };
}

/** Ensure the Work surface is active; fails closed on ambiguous/legacy. */
export async function ensureWorkSurface(page: WorkAnyPage): Promise<{ switched: boolean; detection: Awaited<ReturnType<typeof detectChatGptComposerSurface>> }> {
    const detection = await detectChatGptComposerSurface(page);
    if (detection.surface === 'work') return { switched: false, detection };
    if (detection.surface !== 'chat' || detection.ui !== 'toggle') {
        throw new WebAiError({
            errorCode: 'provider.work-surface-unsupported',
            stage: 'provider-work-select',
            message: `cannot switch to Work from surface=${detection.surface ?? 'none'} (ui=${detection.ui})`,
            retryHint: 'open-chat',
            evidence: detection.evidence as unknown as Record<string, unknown>,
        });
    }
    const workRadio = page.locator('button[role="radio"]').filter({ hasText: /^Work$/i }).first();
    if (!(await workRadio.isVisible().catch(() => false))) {
        throw new WebAiError({
            errorCode: 'provider.work-surface-unsupported',
            stage: 'provider-work-select',
            message: 'Work radio not visible',
            retryHint: 'reload-page',
        });
    }
    await workRadio.click({ timeout: 3000 });
    await page.waitForTimeout?.(300)?.catch?.(() => undefined);
    const after = await detectChatGptComposerSurface(page);
    if (after.surface !== 'work') {
        throw new WebAiError({
            errorCode: 'provider.work-surface-unsupported',
            stage: 'provider-work-select',
            message: `Work switch did not verify (post-click surface: ${after.surface ?? 'none'})`,
            retryHint: 'retry-work-send',
            evidence: after.evidence as unknown as Record<string, unknown>,
        });
    }
    return { switched: true, detection: after };
}

/** Set the Work Power slider to the target value using bounded arrow-key transitions. */
export async function setWorkPower(page: WorkAnyPage, target: PowerMapping): Promise<WorkPickerState> {
    const powerControl = page.locator(WORK_POWER_CONTROL_SELECTOR).first();
    const controlVisible = await powerControl.isVisible().catch(() => false);
    if (!controlVisible) {
        throw new WebAiError({ errorCode: 'provider.work-state-unknown', stage: 'provider-work-select', message: 'Power control not visible in the open Work picker', retryHint: 'open-picker' });
    }
    const slider = page.locator(WORK_SLIDER_SELECTOR).first();
    if ((await page.locator(WORK_SLIDER_SELECTOR).count().catch(() => 0)) === 0) {
        await powerControl.click({ timeout: 3000 });
        await page.waitForTimeout?.(300)?.catch?.(() => undefined);
    }
    if ((await page.locator(WORK_SLIDER_SELECTOR).count().catch(() => 0)) === 0) {
        throw new WebAiError({ errorCode: 'provider.work-state-unknown', stage: 'provider-work-select', message: 'Power slider not present after activating the Power control', retryHint: 'open-picker' });
    }
    const nowStr = await slider.getAttribute('aria-valuenow').catch(() => null);
    const current = nowStr != null ? Number(nowStr) : null;
    if (current == null) {
        throw new WebAiError({ errorCode: 'provider.work-state-unknown', stage: 'provider-work-select', message: 'Power slider aria-valuenow not readable', retryHint: 'reload-page' });
    }
    const diff = target.domValue - current;
    if (diff !== 0) {
        await powerControl.focus().catch(() => undefined);
        const key = diff > 0 ? 'ArrowRight' : 'ArrowLeft';
        for (let i = 0; i < Math.abs(diff); i++) {
            await powerControl.press(key);
            await page.waitForTimeout?.(150)?.catch?.(() => undefined);
        }
    }
    const state = await readWorkPickerState(page);
    if (state.domValue !== target.domValue) {
        throw new WebAiError({ errorCode: 'provider.work-state-unknown', stage: 'provider-work-select', message: `Power slider did not reach target ${target.domValue} (actual: ${state.domValue})`, retryHint: 'retry-power', evidence: state as unknown as Record<string, unknown> });
    }
    return state;
}

export type WorkTaskStatus = 'running' | 'complete' | 'unknown';

/**
 * Read Work task state, main-region-scoped (sidebar titles poison page-wide
 * matching). An unreadable stop probe is UNKNOWN and fails closed — a leftover
 * Copy button on an earlier turn must not read as "finished".
 */
export async function readWorkTaskState(page: WorkAnyPage): Promise<{ surface: 'work'; status: WorkTaskStatus; answerText: string | null; evidence: Record<string, unknown> }> {
    const mainRegion = scopeToMainRegion(page);
    const stopProbe = await probeStopButton(mainRegion);
    const stopVisible = stopProbe === 'visible';
    const thinkingEl = mainRegion?.getByText?.('Thinking', { exact: true });
    const thinkingVisible = thinkingEl ? await thinkingEl.first().isVisible().catch(() => false) : false;
    if (stopVisible || thinkingVisible) {
        return { surface: 'work', status: 'running', answerText: null, evidence: { stopVisible, stopProbe, thinkingVisible, capturedAt: new Date().toISOString() } };
    }
    if (stopProbe === 'unknown') {
        return { surface: 'work', status: 'unknown', answerText: null, evidence: { stopVisible: null, stopProbe, thinkingVisible, capturedAt: new Date().toISOString() } };
    }
    const copyBtn = mainRegion.locator('button[aria-label*="Copy" i]').first();
    const copyVisible = await copyBtn.isVisible().catch(() => false);
    if (copyVisible) {
        const assistantTurns = mainRegion.locator('[data-message-author-role="assistant"]');
        const count = await assistantTurns.count().catch(() => 0);
        let answerText: string | null = null;
        if (count > 0) answerText = await assistantTurns.last().textContent().catch(() => null);
        return { surface: 'work', status: 'complete', answerText: answerText ? answerText.trim() : null, evidence: { copyVisible, stopVisible: false, stopProbe, assistantTurnCount: count, capturedAt: new Date().toISOString() } };
    }
    return { surface: 'work', status: 'unknown', answerText: null, evidence: { stopVisible, stopProbe, thinkingVisible, copyVisible, capturedAt: new Date().toISOString() } };
}

/**
 * Submit the Work prompt by clicking the SCOPED send button, then verify commit
 * evidence (committed user turn + running indicators). NEVER falls back to
 * keyboard Enter — ProseMirror + IME composition can leak characters.
 */
export async function submitWorkPrompt(page: WorkAnyPage, prompt: string, options: { commitTimeoutMs?: number; baselineUrl?: string | null } = {}): Promise<{ committed: boolean; taskUrl: string | null; turnsCount: number; warnings: string[] }> {
    const commitTimeout = options.commitTimeoutMs || WORK_COMMIT_TIMEOUT_MS;
    const sendBtn = page.locator(WORK_SEND_BUTTON_SELECTOR).first();
    if (!(await sendBtn.isVisible().catch(() => false))) {
        throw new WebAiError({ errorCode: 'provider.work-submit-unverified', stage: 'work-submit', message: 'Work send button (data-testid="send-button" inside form) not visible', retryHint: 'reload-page' });
    }
    if (!(await sendBtn.isEnabled().catch(() => false))) {
        throw new WebAiError({ errorCode: 'provider.work-submit-unverified', stage: 'work-submit', message: 'Work send button is disabled — prompt may not have been inserted', retryHint: 'check-composer' });
    }
    await sendBtn.click({ timeout: 5000 });

    const deadline = Date.now() + commitTimeout;
    const normalizedPrompt = prompt.toLowerCase().replace(/\s+/g, ' ').trim();
    const promptPrefix = normalizedPrompt.slice(0, Math.min(normalizedPrompt.length, 120));
    // Sticky: if the stop button was ever unreadable, neither success nor
    // timeout may claim it was checked.
    let lastStopProbe: 'visible' | 'absent' | 'unknown' | null = null;
    const warnings: string[] = [];
    while (Date.now() <= deadline) {
        const turnLocators = await page.locator(CONVERSATION_TURN_SELECTOR).all().catch(() => [] as WorkAnyPage[]);
        let hasPromptTurn = false;
        for (const loc of turnLocators) {
            const text = String(await loc.innerText().catch(() => '')).trim();
            const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
            if (promptPrefix && normalized.includes(promptPrefix)) { hasPromptTurn = true; break; }
        }
        const mainRegion = scopeToMainRegion(page);
        const stopProbe = await probeStopButton(mainRegion);
        if (stopProbe === 'unknown') lastStopProbe = 'unknown';
        else if (lastStopProbe !== 'unknown') lastStopProbe = stopProbe;
        if (hasPromptTurn && (stopProbe === 'visible' || turnLocators.length > 0)) {
            const taskUrl = typeof page.url === 'function' ? page.url() : null;
            const finalWarnings = lastStopProbe === 'unknown' ? [...warnings, 'work-stop-probe-unverified'] : warnings;
            return { committed: true, taskUrl, turnsCount: turnLocators.length, warnings: finalWarnings };
        }
        await page.waitForTimeout?.(500)?.catch?.(() => undefined);
    }
    throw new WebAiError({
        errorCode: 'provider.work-submit-unverified',
        stage: 'work-submit',
        message: `Work prompt commit not verified within ${commitTimeout}ms`,
        retryHint: 'retry-work-send',
        evidence: { lastStopProbe },
    });
}

/**
 * Reattach guard: a running Work session must be polled on ITS OWN target —
 * running-task reattach is not supported in v1; and a bare-origin
 * conversationUrl session must never resolve against the generic origin.
 */
export function assertWorkSessionPollable(session: { sessionId?: string; targetId?: string; conversationUrl?: string | null }, actualTargetId: string | null): void {
    if (session.targetId && actualTargetId && actualTargetId !== session.targetId) {
        throw new WebAiError({
            errorCode: 'provider.work-reattach-unverified',
            stage: 'work-poll',
            message: `Work session target mismatch: expected ${session.targetId}, got ${actualTargetId}. Running-task reattach is not supported in v1.`,
            retryHint: 'reattach-session',
            evidence: { sessionId: session.sessionId, expectedTargetId: session.targetId, actualTargetId },
        });
    }
    const url = session.conversationUrl || '';
    const isBareOrigin = /^https:\/\/(chatgpt\.com|chat\.openai\.com)\/?$/.test(url);
    if (isBareOrigin) {
        throw new WebAiError({
            errorCode: 'provider.work-reattach-unverified',
            stage: 'work-poll',
            message: `Work session ${session.sessionId} has bare-origin conversationUrl (${url}); refusing to poll the wrong tab`,
            retryHint: 'resend-work',
            evidence: { sessionId: session.sessionId, conversationUrl: url, surface: 'work' },
        });
    }
}

