import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { JAW_HOME } from '../../core/config.js';
import { domHashAround, selectorMatchSummary } from './dom-hash.js';
import { listSessions } from './session.js';
import { CHATGPT_COPY_SELECTORS, GEMINI_COPY_SELECTORS, GROK_COPY_SELECTORS } from './copy-markdown.js';
import { CHATGPT_MODEL_SELECTOR_BUTTONS } from './chatgpt-model.js';
import { buildWebAiSnapshot, summarizeSnapshotForDoctor } from './ax-snapshot.js';
import { observeProviderTargets } from './observe-targets.js';
import { editorContractForVendor } from './vendor-editor-contract.js';
import { reportCacheMetricsFromEvents } from './cache-metrics.js';
import type { WebAiSessionRecord } from './types.js';

const CHATGPT_FEATURES = [
    { feature: 'composer', selectors: ['#prompt-textarea', '[data-testid="composer-textarea"]', 'div[contenteditable="true"]'] },
    { feature: 'model-picker', selectors: [...CHATGPT_MODEL_SELECTOR_BUTTONS] },
    { feature: 'upload', selectors: ['button[aria-label*="Upload" i]', 'button[aria-label*="Attach" i]', 'button[data-testid*="plus" i]'] },
    { feature: 'response-feed', selectors: ['[data-message-author-role="assistant"]', '[data-turn="assistant"]', 'article[data-testid^="conversation-turn"]'] },
    { feature: 'copy-fallback', selectors: CHATGPT_COPY_SELECTORS.copyButtonSelectors },
    { feature: 'streaming-indicator', selectors: ['button[data-testid="stop-button"]', 'button[aria-label*="Stop" i]'] },
];

const GEMINI_FEATURES = [
    { feature: 'composer', selectors: ['rich-textarea .ql-editor', '[role="textbox"][aria-label*="prompt" i]', 'div[contenteditable="true"]'] },
    { feature: 'model-picker', selectors: ['button[data-test-id="bard-mode-menu-button"]', 'button[aria-label="Open mode picker"]'] },
    { feature: 'upload', selectors: ['button[aria-label="Open upload file menu"]', 'button[aria-label*="upload file menu" i]'] },
    { feature: 'response-feed', selectors: ['model-response', '[data-response-index]'] },
    { feature: 'copy-fallback', selectors: GEMINI_COPY_SELECTORS.copyButtonSelectors },
    { feature: 'streaming-indicator', selectors: ['.response-footer.complete', 'message-actions', '[aria-label*="Good response" i]'] },
];

const GROK_FEATURES = [
    { feature: 'composer', selectors: ['.ProseMirror[contenteditable="true"]', '[contenteditable="true"].ProseMirror'] },
    { feature: 'model-picker', selectors: ['button[aria-label="Model select"]', 'button[aria-label*="Model select" i]'] },
    { feature: 'upload', selectors: ['button[aria-label*="Upload" i]', 'button[aria-label*="Attach" i]', 'button[data-testid*="plus" i]'] },
    { feature: 'response-feed', selectors: ['[data-testid="assistant-message"]', '[id^="response-"]:has([data-testid="assistant-message"])'] },
    { feature: 'copy-fallback', selectors: GROK_COPY_SELECTORS.copyButtonSelectors },
    { feature: 'streaming-indicator', selectors: ['button[aria-label*="Stop" i]'] },
];

const PROVIDER_HOSTS: Record<string, Set<string>> = {
    chatgpt: new Set(['chatgpt.com', 'chat.openai.com']),
    gemini: new Set(['gemini.google.com']),
    grok: new Set(['grok.com']),
};

const DEFAULT_MAX_REPORT_BYTES = 4096;
const FULL_MAX_REPORT_BYTES = 16384;

export interface FeatureDefinition {
    feature: string;
    selectors: string[];
}

export interface FeatureDiagnosis {
    feature: string;
    selectorsTried: string[];
    selectorMatches: Array<{ selector: string; matched: number; visible: boolean }>;
    selectorCounts: { tried: number; matched: number; total: number };
    state: 'ok' | 'warn' | 'fail';
    domHash: string | null;
}

export interface DoctorOptions {
    vendor?: string;
    snapshot?: boolean | 'interactive';
    snapshotMaxDepth?: number;
    cacheMetrics?: boolean;
    full?: boolean;
    maxChars?: number;
}

export interface DoctorReport {
    vendor: string;
    url: string | null;
    capturedAt: string;
    features: FeatureDiagnosis[];
    snapshot?: ReturnType<typeof summarizeSnapshotForDoctor>;
    semanticTargets?: Record<string, Array<Record<string, unknown>>>;
    lastSession: Record<string, unknown> | null;
    warnings: string[];
    cacheMetrics?: import('./cache-metrics.js').CacheMetricsReport | null;
    truncated?: boolean;
    maxBytes?: number;
}

export interface DoctorDeps {
    getPage: () => Promise<any>;
}

export function featureDefinitionsForVendor(vendor: string): FeatureDefinition[] {
    const deepCopy = (f: FeatureDefinition) => ({ ...f, selectors: [...f.selectors] });
    switch (vendor) {
        case 'chatgpt': return CHATGPT_FEATURES.map(deepCopy);
        case 'gemini': return GEMINI_FEATURES.map(deepCopy);
        case 'grok': return GROK_FEATURES.map(deepCopy);
        default: return [];
    }
}

export async function diagnoseFeature(page: any, feature: FeatureDefinition, options: { maxChars?: number } = {}): Promise<FeatureDiagnosis> {
    const matches = await selectorMatchSummary(page, feature.selectors);
    const anyVisible = matches.some(m => m.visible);
    const anyMatched = matches.some(m => m.matched > 0);
    const totalMatches = matches.reduce((s, m) => s + m.matched, 0);
    return {
        feature: feature.feature,
        selectorsTried: feature.selectors,
        selectorMatches: matches.filter(m => m.matched > 0),
        selectorCounts: { tried: feature.selectors.length, matched: matches.filter(m => m.matched > 0).length, total: totalMatches },
        state: anyVisible ? 'ok' : anyMatched ? 'warn' : 'fail',
        domHash: await domHashAround(page, feature.selectors, options),
    };
}

export async function runDoctor(deps: DoctorDeps, options: DoctorOptions = {}): Promise<DoctorReport> {
    const page = await deps.getPage();
    const vendor = options.vendor || 'chatgpt';
    const url = await page.url();
    const warnings: string[] = [];

    const allowedHosts = PROVIDER_HOSTS[vendor];
    let hostOk = false;
    if (allowedHosts) {
        try { hostOk = allowedHosts.has(new URL(url).hostname); } catch { hostOk = false; }
    }
    if (!hostOk) {
        warnings.push(`host-mismatch:expected=${[...(allowedHosts || [])].join(',')}`);
    }

    const features = hostOk
        ? await Promise.all(featureDefinitionsForVendor(vendor).map(f => diagnoseFeature(page, f, options)))
        : featureDefinitionsForVendor(vendor).map(f => ({
            feature: f.feature, selectorsTried: f.selectors, selectorMatches: [],
            selectorCounts: { tried: f.selectors.length, matched: 0, total: 0 },
            state: 'fail' as const, domHash: null,
        }));

    let snapshotSummary = null;
    let semanticTargets = null;
    if (options.snapshot === true || options.snapshot === 'interactive') {
        try {
            const snapshot = await buildWebAiSnapshot(page, {
                provider: vendor,
                compact: true,
                interactiveOnly: true,
                maxDepth: options.snapshotMaxDepth || 6,
            });
            snapshotSummary = summarizeSnapshotForDoctor(snapshot);
            const observed = await observeProviderTargets(page, {
                provider: vendor,
                featureMap: editorContractForVendor(vendor),
                snapshot,
            });
            semanticTargets = sanitizeObservedTargetsForDoctor(observed as Record<string, Array<Record<string, unknown>>>);
        } catch (err) {
            warnings.push(`snapshot-failed:${(err as { errorCode?: string; message?: string })?.errorCode || (err as Error)?.message || String(err)}`);
            snapshotSummary = {
                enabled: false,
                contentSafe: true,
                snapshotId: null,
                axHash: null,
                domHash: null,
                interactiveCount: 0,
                tokenEstimate: 0,
                topRefs: [],
            };
        }
    }

    const lastSession = findActiveSession({ vendor, conversationUrl: url });
    const report: DoctorReport = {
        vendor,
        url: redactUrl(url),
        capturedAt: new Date().toISOString(),
        features,
        ...(snapshotSummary ? { snapshot: snapshotSummary } : {}),
        ...(semanticTargets ? { semanticTargets } : {}),
        lastSession: lastSession ? summarizeSessionForDoctor(lastSession) : null,
        warnings,
    };

    if (options.cacheMetrics) {
        const metrics = reportCacheMetricsFromEvents(JAW_HOME);
        report.cacheMetrics = metrics;
    }

    const maxBytes = options.full ? FULL_MAX_REPORT_BYTES : DEFAULT_MAX_REPORT_BYTES;
    return clampReport(report, maxBytes);
}

function redactUrl(url: string): string | null {
    try {
        const u = new URL(url);
        return `${u.protocol}//${u.hostname}${u.pathname}`;
    } catch {
        return url;
    }
}

function findActiveSession(input: { vendor: string; conversationUrl: string }): WebAiSessionRecord | null {
    const sessions = listSessions({ vendor: input.vendor as any });
    const activeStatuses = new Set(['sent', 'streaming']);
    for (let i = sessions.length - 1; i >= 0; i--) {
        const s = sessions[i]!;
        if (activeStatuses.has(s.status) && (s.conversationUrl === input.conversationUrl || s.url === input.conversationUrl)) {
            return s;
        }
    }
    return null;
}

function summarizeSessionForDoctor(session: WebAiSessionRecord): Record<string, unknown> {
    const anySession = session as any;
    return {
        sessionId: session.sessionId,
        status: session.status,
        deadlineAt: anySession.deadlineAt || null,
        composerBeforeChars: anySession.composerBefore?.length ?? null,
        composerAfterChars: anySession.composerAfter?.length ?? null,
    };
}

function sanitizeObservedTargetsForDoctor(observed: Record<string, Array<Record<string, unknown>>> = {}): Record<string, Array<Record<string, unknown>>> {
    const out: Record<string, Array<Record<string, unknown>>> = {};
    for (const [feature, candidates] of Object.entries(observed)) {
        out[feature] = (candidates || []).slice(0, 8).map(candidate => {
            const { name, ...rest } = candidate;
            return {
                ...rest,
                ...(name !== undefined ? {
                    nameHash: name ? doctorHashField(name as string) : null,
                    nameChars: name ? String(name).length : 0,
                } : {}),
            };
        });
    }
    return out;
}

function doctorHashField(value: string): string {
    return `sha256:${createHash('sha256').update(String(value)).digest('hex').slice(0, 12)}`;
}

function byteLength(str: string): number {
    return Buffer.byteLength(str, 'utf8');
}

function clampReport(report: DoctorReport, maxBytes: number): DoctorReport {
    if (byteLength(JSON.stringify(report)) <= maxBytes) return report;
    const rawBytes = byteLength(JSON.stringify(report));
    const clamped: DoctorReport = { ...report, truncated: true, maxBytes };
    clamped.features = clamped.features.map(f => ({
        feature: f.feature,
        selectorsTried: (f as FeatureDiagnosis).selectorsTried || [],
        selectorMatches: (f as FeatureDiagnosis).selectorMatches || [],
        selectorCounts: f.selectorCounts,
        state: f.state,
        domHash: f.domHash,
    } as FeatureDiagnosis));
    clamped.lastSession = null;
    clamped.warnings = [...(clamped.warnings || []), `report-clamped:${rawBytes}→${maxBytes}`];
    if (byteLength(JSON.stringify(clamped)) > maxBytes) {
        clamped.features = clamped.features.map(f => ({ feature: f.feature, selectorsTried: [], selectorMatches: [], selectorCounts: { tried: 0, matched: 0, total: 0 }, state: f.state, domHash: null } as FeatureDiagnosis));
        clamped.warnings = [`report-clamped:${rawBytes}→${maxBytes}`];
    }
    if (byteLength(JSON.stringify(clamped)) > maxBytes) {
        clamped.url = clamped.url?.slice(0, 64) || null;
    }
    if (byteLength(JSON.stringify(clamped)) > maxBytes) {
        return { vendor: clamped.vendor, truncated: true, maxBytes, features: [], warnings: [`report-clamped:${rawBytes}→${maxBytes}`], url: clamped.url, capturedAt: clamped.capturedAt, lastSession: null };
    }
    return clamped;
}
