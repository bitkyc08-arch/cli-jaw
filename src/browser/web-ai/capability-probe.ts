/**
 * 104.8 — Runtime capability-probe engine (port of agbrowse `capability.mjs`).
 *
 * Distinct from the DECLARATIVE registry in `capability-registry.ts` (catalog 201):
 * this runs live DOM probes against a vendor tab and reports, per capability, a
 * `{ capabilityId, state, evidence, next }` row. `state` aggregates worst → best
 * ('fail' > 'warn' > 'ok'/'unknown'); `next` is the recommended retry hint.
 *
 * Side-effect contract: probes MAY open and read DOM but MUST NOT submit prompts
 * or mutate model selection. Probes that open menus must close them before resolving.
 */

import type { Page } from 'playwright-core';

export type CapabilityState = 'ok' | 'warn' | 'fail' | 'unknown';

export interface CapabilityProbeResult {
    state: CapabilityState;
    evidence: unknown;
    next: string;
}

export interface CapabilityRow extends CapabilityProbeResult {
    capabilityId: string;
}

export type CapabilityInput = Record<string, unknown>;

export interface CapabilityDeps {
    getPage(): Promise<Page>;
}

export type CapabilityProbeFn = (deps: CapabilityDeps, input: CapabilityInput) => Promise<CapabilityProbeResult>;

export interface CapabilityDef {
    capabilityId: string;
    probeFn: CapabilityProbeFn;
}

export function defineCapability(capabilityId: string, probeFn: CapabilityProbeFn): CapabilityDef {
    if (typeof probeFn !== 'function') throw new Error(`capability ${capabilityId} requires a probe function`);
    return { capabilityId, probeFn };
}

export async function runCapabilities(deps: CapabilityDeps, capabilities: readonly CapabilityDef[], input: CapabilityInput = {}): Promise<CapabilityRow[]> {
    const rows: CapabilityRow[] = [];
    for (const cap of capabilities) {
        // A single `probe` selector lets callers run just one row (e.g. status --probe gemini-composer-visible).
        if (typeof input['probe'] === 'string' && input['probe'] !== cap.capabilityId) continue;
        try {
            // eslint-disable-next-line no-await-in-loop -- probes share one tab; serial keeps DOM reads coherent.
            const probeResult = await cap.probeFn(deps, input);
            rows.push({ capabilityId: cap.capabilityId, ...normalizeRow(probeResult) });
        } catch (err) {
            rows.push({
                capabilityId: cap.capabilityId,
                state: 'unknown',
                evidence: { error: (err as { message?: string })?.message || String(err) },
                next: 're-snapshot',
            });
        }
    }
    return rows;
}

export function worstCapabilityState(rows: readonly CapabilityRow[]): CapabilityState {
    if (!Array.isArray(rows) || rows.length === 0) return 'unknown';
    if (rows.some((r) => r.state === 'fail')) return 'fail';
    if (rows.some((r) => r.state === 'warn')) return 'warn';
    if (rows.every((r) => r.state === 'ok')) return 'ok';
    return 'unknown';
}

function normalizeRow(probeResult: Partial<CapabilityProbeResult> = {}): CapabilityProbeResult {
    return {
        state: probeResult.state || 'unknown',
        evidence: probeResult.evidence ?? null,
        next: probeResult.next || 'send',
    };
}

export async function probeHostMatches(page: Pick<Page, 'url'> | null | undefined, expectedHosts: Set<string>): Promise<CapabilityProbeResult> {
    try {
        const url = page?.url?.() || '';
        const host = new URL(url).hostname.replace(/^www\./, '');
        if (expectedHosts.has(host)) return { state: 'ok', evidence: { url, host }, next: 'send' };
        return { state: 'fail', evidence: { url, host, expected: [...expectedHosts] }, next: 'tab-switch' };
    } catch {
        return { state: 'fail', evidence: { url: page?.url?.() || null }, next: 'tab-switch' };
    }
}

export interface VisibleSelectorProbeOptions {
    timeoutMs?: number;
    okNext?: string;
    failState?: CapabilityState;
    failNext?: string;
}

export async function probeFirstVisibleSelector(page: Page, selectors: readonly string[], options: VisibleSelectorProbeOptions = {}): Promise<CapabilityProbeResult> {
    const timeoutMs = options.timeoutMs ?? 1500;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
        for (const selector of selectors) {
            try {
                const locator = page.locator(selector).first();
                if (typeof locator.isVisible !== 'function') continue;
                // eslint-disable-next-line no-await-in-loop -- ordered selector preference: first visible wins.
                const visible = await locator.isVisible().catch(() => false);
                if (visible) return { state: 'ok', evidence: { matched: selector, visible: true }, next: options.okNext || 'send' };
            } catch { /* keep trying the next selector */ }
        }
        if (Date.now() >= deadline) break;
        // eslint-disable-next-line no-await-in-loop -- poll until the deadline.
        await page.waitForTimeout?.(100).catch(() => undefined);
    }
    return { state: options.failState || 'fail', evidence: { selectorsTried: [...selectors] }, next: options.failNext || 're-snapshot' };
}
