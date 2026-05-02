import { createHash } from 'node:crypto';
import { CACHE_SCHEMA_VERSION, RESOLUTION_SOURCES, VALIDATION_REASONS, VALIDATION_THRESHOLD } from './constants.js';
import { WebAiError, wrapError } from './errors.js';
import type { ResolvedActionTarget } from './action-cache.js';
import type { WebAiVendor } from './types.js';

export { RESOLUTION_SOURCES as ResolutionSource } from './constants.js';

type ActionKind = 'click' | 'fill' | string;

export interface SemanticTarget {
    roles?: string[];
    names?: RegExp[];
    excludeNames?: RegExp[];
    cssFallbacks?: string[];
    required?: boolean;
}

export interface TargetCandidate extends ResolvedActionTarget {
    source?: string;
    ref?: string | null;
    selector?: string | null;
    role?: string | null;
    name?: string | null;
    confidence?: number;
    count?: number;
    contentEditable?: boolean;
}

export interface SnapshotRef {
    ref?: string;
    role?: string;
    name?: string;
    selector?: string | null;
}

export interface TargetSnapshot {
    refs?: SnapshotRef[] | Record<string, SnapshotRef>;
}

export interface RefRegistry {
    stale?: boolean;
    refs?: Record<string, TargetCandidate>;
}

export interface PageLocator {
    count(): Promise<number>;
    first(): PageLocator;
    isVisible(): Promise<boolean>;
    isEnabled(): Promise<boolean>;
    isEditable?(): Promise<boolean>;
    evaluate<T>(fn: (node: any) => T | Promise<T>): Promise<T>;
}

export interface PageLike {
    url(): string;
    locator(selector: string): PageLocator;
    getByRole(role: string, options: { name: RegExp }): PageLocator;
}

export interface ResolveActionTargetContext {
    provider: WebAiVendor | string;
    intent: string;
    actionKind?: ActionKind;
    snapshot?: TargetSnapshot | null;
    registry?: RefRegistry | null;
    cache?: {
        get(input: {
            provider?: string | null;
            intent?: string | null;
            actionKind?: string | null;
            urlHost?: string | null;
            fingerprint?: unknown;
        }): { target: TargetCandidate } | null;
    } | null;
    fingerprint?: unknown;
    feature?: string | null;
    semanticTargetOverride?: SemanticTarget | null;
    selectors?: string[] | null;
    contractVersion?: string | null;
    framePath?: string | null;
    browserConfigHash?: string | null;
}

export interface ValidationResult {
    ok: boolean;
    reason?: string;
    count?: number;
    resolvedVia?: string;
    confidence?: number;
}

export interface ResolveActionTargetResult {
    ok: boolean;
    target?: TargetCandidate;
    attempts: Array<{
        source?: string;
        ref?: string | null;
        selector?: string | null;
        validation: ValidationResult;
    }>;
    errorCode?: string;
    provider?: string;
    intent?: string;
    actionKind?: ActionKind;
    feature?: string | null;
    required?: boolean;
}

const INTENT_FEATURE: Readonly<Record<string, string>> = Object.freeze({
    'composer.fill': 'composer',
    'composer.click': 'composer',
    'copy.lastResponse': 'copyButton',
    'modelPicker.open': 'modelPicker',
    'modelPicker.click': 'modelPicker',
    'upload.attach': 'uploadSurface',
    'upload.click': 'uploadSurface',
    'responseFeed.read': 'responseFeed',
    'streaming.check': 'streamingIndicator',
    'stop.click': 'streamingIndicator',
});

const SEMANTIC_TARGETS: Record<string, Record<string, SemanticTarget>> = {
    chatgpt: {
        composer: { roles: ['textbox'], names: [/message/i, /prompt/i, /chatgpt/i], excludeNames: [/search/i], cssFallbacks: ['#prompt-textarea', '[data-testid="composer-textarea"]', 'div[contenteditable="true"]'], required: true },
        modelPicker: { roles: ['button', 'combobox'], names: [/model/i, /gpt/i], cssFallbacks: ['button[aria-label*="model" i]', 'button[data-testid*="model" i]'] },
        uploadSurface: { roles: ['button'], names: [/attach/i, /upload/i, /file/i, /add/i], cssFallbacks: ['button[aria-label*="Upload" i]', 'button[aria-label*="Attach" i]', 'button[data-testid*="plus" i]'] },
        responseFeed: { roles: ['article', 'region', 'group'], names: [/assistant/i, /response/i], cssFallbacks: ['[data-message-author-role="assistant"]', '[data-turn="assistant"]'] },
        copyButton: { roles: ['button'], names: [/copy/i], cssFallbacks: ['button[aria-label*="copy" i]', '[data-testid*="copy" i]'] },
        streamingIndicator: { roles: ['button'], names: [/stop/i], cssFallbacks: ['button[data-testid="stop-button"]', 'button[aria-label*="Stop" i]'] },
    },
    gemini: {
        composer: { roles: ['textbox'], names: [/prompt/i, /message/i, /ask/i], excludeNames: [/search/i], cssFallbacks: ['rich-textarea .ql-editor', '[role="textbox"][aria-label*="prompt" i]', 'div[contenteditable="true"]'], required: true },
        modelPicker: { roles: ['button', 'combobox'], names: [/model/i, /mode/i, /picker/i], cssFallbacks: ['button[data-test-id="bard-mode-menu-button"]', 'button[aria-label="Open mode picker"]'] },
        uploadSurface: { roles: ['button'], names: [/upload/i, /file/i, /attach/i], cssFallbacks: ['button[aria-label="Open upload file menu"]', 'button[aria-label*="upload file menu" i]'] },
        responseFeed: { roles: ['article', 'region', 'group'], names: [/response/i, /gemini/i], cssFallbacks: ['model-response', '[data-response-index]'] },
        copyButton: { roles: ['button'], names: [/copy/i], cssFallbacks: ['button[aria-label*="copy" i]'] },
        streamingIndicator: { roles: ['button', 'status'], names: [/stop/i, /response/i], cssFallbacks: ['.response-footer.complete', 'message-actions'] },
    },
    grok: {
        composer: { roles: ['textbox'], names: [/message/i, /prompt/i, /ask/i, /grok/i], excludeNames: [/search/i], cssFallbacks: ['.ProseMirror[contenteditable="true"]', '[contenteditable="true"].ProseMirror'], required: true },
        modelPicker: { roles: ['button', 'combobox'], names: [/model/i], cssFallbacks: ['button[aria-label="Model select"]', 'button[aria-label*="Model select" i]'] },
        uploadSurface: { roles: ['button'], names: [/upload/i, /attach/i, /file/i], cssFallbacks: ['button[aria-label*="Upload" i]', 'button[aria-label*="Attach" i]'] },
        responseFeed: { roles: ['article', 'region', 'group'], names: [/assistant/i, /response/i], cssFallbacks: ['[data-testid="assistant-message"]'] },
        copyButton: { roles: ['button'], names: [/copy/i], cssFallbacks: ['button[aria-label*="copy" i]'] },
        streamingIndicator: { roles: ['button'], names: [/stop/i], cssFallbacks: ['button[aria-label*="Stop" i]'] },
    },
};

export function resolveIntentFeature(intent: string, featureOverride: string | null = null): string | null {
    if (featureOverride) return featureOverride;
    return INTENT_FEATURE[intent] || null;
}

export function semanticTargetsForVendor(vendor = 'chatgpt'): Record<string, SemanticTarget> {
    return SEMANTIC_TARGETS[vendor] || SEMANTIC_TARGETS.chatgpt || {};
}

export async function resolveActionTarget(page: PageLike, ctx: ResolveActionTargetContext): Promise<ResolveActionTargetResult> {
    try {
        const {
            provider,
            intent,
            actionKind = 'click',
            snapshot = null,
            registry = null,
            cache = null,
            fingerprint = null,
            feature: featureOverride = null,
            semanticTargetOverride = null,
            selectors: selectorsOverride = null,
        } = ctx;
        const feature = resolveIntentFeature(intent, featureOverride);
        const allTargets = semanticTargetsForVendor(provider);
        const semanticTarget = semanticTargetOverride || (feature ? allTargets[feature] || null : null);
        const selectors = selectorsOverride || semanticTarget?.cssFallbacks || [];
        const attempts: ResolveActionTargetResult['attempts'] = [];

        let urlHost: string | null = null;
        try {
            urlHost = new URL(page.url()).hostname;
        } catch {
            urlHost = null;
        }

        const cached = cache?.get({ provider, intent, actionKind, urlHost, fingerprint });
        if (cached) {
            const validation = await validateResolvedTarget(page, cached.target, {
                semanticTarget,
                actionKind,
                registry,
                contractVersion: ctx.contractVersion,
                framePath: ctx.framePath,
                browserConfigHash: ctx.browserConfigHash,
            });
            attempts.push({ source: RESOLUTION_SOURCES.CACHE, validation });
            if (validation.ok) return { ok: true, target: { ...cached.target, resolution: RESOLUTION_SOURCES.CACHE }, attempts };
        }

        const candidates = await collectTargetCandidates(page, { provider, feature, semanticTarget, snapshot, registry, selectors });
        const ranked = rankTargetCandidates(candidates, {
            expectedRole: semanticTarget?.roles?.[0] || null,
            expectedNames: semanticTarget?.names || [],
        });
        for (const candidate of ranked) {
            const validation = await validateResolvedTarget(page, candidate, { semanticTarget, actionKind, registry });
            attempts.push({ source: candidate.source, ref: candidate.ref || null, selector: candidate.selector || null, validation });
            if (validation.ok) return { ok: true, target: { ...candidate, resolution: candidate.source }, attempts };
        }
        return {
            ok: false,
            errorCode: 'TARGET_UNRESOLVED',
            provider,
            intent,
            actionKind,
            feature,
            required: semanticTarget?.required || false,
            attempts,
        };
    } catch (err) {
        throw wrapError(err, { stage: 'self-heal-resolve', retryHint: 're-snapshot' });
    }
}

export async function validateResolvedTarget(
    page: PageLike,
    target: TargetCandidate | null | undefined,
    input: {
        semanticTarget?: SemanticTarget | null;
        actionKind?: ActionKind;
        registry?: RefRegistry | null;
        contractVersion?: string | null;
        framePath?: string | null;
        browserConfigHash?: string | null;
    } = {},
): Promise<ValidationResult> {
    const { semanticTarget = null, actionKind = 'click', registry = null, contractVersion = null, framePath = null, browserConfigHash = null } = input;
    try {
        if (target?.schemaVersion && target.schemaVersion !== CACHE_SCHEMA_VERSION) return { ok: false, reason: VALIDATION_REASONS.SCHEMA_VERSION_MISMATCH };
        if (target?.contractVersion && contractVersion && target.contractVersion !== contractVersion) return { ok: false, reason: VALIDATION_REASONS.CONTRACT_VERSION_MISMATCH };
        if (target?.framePath && framePath && target.framePath !== framePath) return { ok: false, reason: VALIDATION_REASONS.FRAME_PATH_MISMATCH };
        if (target?.browserConfigHash && browserConfigHash && target.browserConfigHash !== browserConfigHash) return { ok: false, reason: VALIDATION_REASONS.BROWSER_CONFIG_MISMATCH };

        let selector = target?.selector || null;
        if (target?.ref && registry) {
            if (isRegistryStale(registry)) return { ok: false, reason: VALIDATION_REASONS.REF_STALE };
            try {
                const entry = await resolveRef(registry, target.ref);
                if (entry.selector) selector = entry.selector;
            } catch {
                return { ok: false, reason: VALIDATION_REASONS.REF_INVALID };
            }
        }

        if (!selector) {
            if (target?.ref && target.role && target.name) {
                const roleLocator = page.getByRole(target.role, { name: new RegExp(escapeForRegExp(target.name), 'i') });
                const roleCount = await roleLocator.count().catch(() => 0);
                if (roleCount === 0) return { ok: false, reason: VALIDATION_REASONS.NOT_FOUND };
                if (roleCount > 1) return { ok: false, reason: VALIDATION_REASONS.AMBIGUOUS_SELECTOR, count: roleCount };
                const roleEl = roleLocator.first();
                if (!await roleEl.isVisible().catch(() => false)) return { ok: false, reason: VALIDATION_REASONS.NOT_VISIBLE };
                if (!await roleEl.isEnabled().catch(() => false)) return { ok: false, reason: VALIDATION_REASONS.NOT_ENABLED };
                if (actionKind === 'fill' && !await roleEl.isEditable?.().catch(() => false)) return { ok: false, reason: VALIDATION_REASONS.NOT_EDITABLE };
                return { ok: true, resolvedVia: 'role-locator', confidence: 1.0 };
            }
            if (target?.ref) return { ok: false, reason: VALIDATION_REASONS.REF_NO_SELECTOR };
            return { ok: false, reason: VALIDATION_REASONS.MISSING_SELECTOR };
        }

        const locator = page.locator(selector);
        const count = await locator.count().catch(() => 0);
        if (count === 0) return { ok: false, reason: VALIDATION_REASONS.NOT_FOUND };
        if (count > 1) return { ok: false, reason: VALIDATION_REASONS.AMBIGUOUS_SELECTOR, count };
        const el = locator.first();
        if (!await el.isVisible().catch(() => false)) return { ok: false, reason: VALIDATION_REASONS.NOT_VISIBLE };
        if (!await el.isEnabled().catch(() => false)) return { ok: false, reason: VALIDATION_REASONS.NOT_ENABLED };
        if (actionKind === 'fill' && !await el.isEditable?.().catch(() => false)) return { ok: false, reason: VALIDATION_REASONS.NOT_EDITABLE };
        if (semanticTarget?.roles?.length || semanticTarget?.names?.length || target?.role || target?.name || target?.nameHash) {
            const validation = await runValidationContract(el, { target: target || {}, semanticTarget, actionKind });
            if (!validation.ok) return { ok: false, reason: validation.reason, confidence: validation.confidence };
            return { ok: true, confidence: validation.confidence };
        }
        return { ok: true, confidence: 1.0 };
    } catch (err) {
        throw wrapError(err, { stage: 'self-heal-validate', retryHint: 're-snapshot' });
    }
}

export async function locatorForResolvedTarget(page: PageLike, target: TargetCandidate, { registry }: { registry?: RefRegistry | null } = {}): Promise<PageLocator> {
    if (target.selector) return page.locator(target.selector).first();
    if (target.ref) {
        if (!registry) throw new WebAiError({ errorCode: 'internal.unhandled', stage: 'self-heal', retryHint: 'report', message: `ref ${target.ref} requires a registry to resolve`, evidence: { ref: target.ref } });
        const resolved = await resolveRef(registry, target.ref);
        if (resolved.selector) return page.locator(resolved.selector).first();
        if (resolved.role && resolved.name) return page.getByRole(resolved.role, { name: new RegExp(escapeForRegExp(resolved.name), 'i') }).first();
        throw new WebAiError({ errorCode: 'internal.unhandled', stage: 'self-heal', retryHint: 'report', message: `ref ${target.ref} resolved but not actionable`, evidence: { ref: target.ref, role: resolved.role } });
    }
    throw new WebAiError({ errorCode: 'internal.unhandled', stage: 'self-heal', retryHint: 'report', message: 'target has neither selector nor ref', evidence: { target } });
}

async function collectTargetCandidates(
    page: PageLike,
    input: { provider: string; feature: string | null; semanticTarget: SemanticTarget | null; snapshot: TargetSnapshot | null; registry: RefRegistry | null; selectors: string[] },
): Promise<TargetCandidate[]> {
    const candidates: TargetCandidate[] = [];
    if (input.snapshot?.refs && (!input.registry || !isRegistryStale(input.registry))) {
        const observed = observeProviderTargets(input.snapshot, semanticTargetsForVendor(input.provider));
        const observedFeature = input.feature ? observed[input.feature] || [] : [];
        if (observedFeature.length) {
            for (const candidate of observedFeature) candidates.push({ ...candidate, source: candidate.source || RESOLUTION_SOURCES.OBSERVE_RANKED });
        }
    }
    for (const selector of input.selectors) {
        if (candidates.some((candidate) => candidate.selector === selector)) continue;
        const count = await page.locator(selector).count().catch(() => 0);
        if (count > 0) candidates.push({ source: RESOLUTION_SOURCES.CSS_FALLBACK, selector, count, confidence: count === 1 ? 3 : 1 });
    }
    return candidates;
}

function observeProviderTargets(snapshot: TargetSnapshot, featureMap: Record<string, SemanticTarget>): Record<string, TargetCandidate[]> {
    const refs = Array.isArray(snapshot.refs) ? snapshot.refs : Object.values(snapshot.refs || {});
    const results: Record<string, TargetCandidate[]> = {};
    for (const [feature, target] of Object.entries(featureMap)) {
        const candidates = refs
            .filter((ref) => targetMatchesRef(target, ref))
            .map((ref) => ({
                source: RESOLUTION_SOURCES.SNAPSHOT_SEMANTIC,
                ref: ref.ref,
                selector: ref.selector || null,
                role: ref.role || null,
                name: ref.name || '',
                confidence: scoreCandidate({ role: ref.role, name: ref.name || '' }, target),
            }));
        results[feature] = rankTargetCandidates(candidates, { expectedRole: target.roles?.[0] || null, expectedNames: target.names || [] });
    }
    return results;
}

export function rankTargetCandidates(candidates: TargetCandidate[], input: { expectedRole?: string | null; expectedNames?: RegExp[] } = {}): TargetCandidate[] {
    const { expectedRole = null, expectedNames = [] } = input;
    return [...(candidates || [])].sort((a, b) => {
        const aScore = Number(a.confidence || 0) + (expectedRole && a.role === expectedRole ? 2 : 0) + (expectedNames.some((pattern) => patternMatches(pattern, a.name || '')) ? 1 : 0);
        const bScore = Number(b.confidence || 0) + (expectedRole && b.role === expectedRole ? 2 : 0) + (expectedNames.some((pattern) => patternMatches(pattern, b.name || '')) ? 1 : 0);
        return bScore - aScore;
    });
}

async function runValidationContract(locator: PageLocator, input: { target: TargetCandidate; semanticTarget: SemanticTarget | null; actionKind: ActionKind }): Promise<ValidationResult> {
    const info = await locator.evaluate((node) => {
        const explicitRole = node.getAttribute('role');
        const tag = node.tagName.toLowerCase();
        const isEditable = node.isContentEditable === true || node.contentEditable === 'true';
        const implicitRole = explicitRole || (tag === 'textarea' ? 'textbox' : (tag === 'input' ? 'textbox' : (isEditable ? 'textbox' : (tag === 'button' ? 'button' : (tag === 'a' ? 'link' : tag)))));
        const label = node.getAttribute('aria-label') || node.textContent?.trim()?.slice(0, 100) || '';
        return { role: implicitRole, label, tagName: tag, isEditable };
    }).catch(() => null);
    if (!info) return { ok: false, reason: 'eval-failed', confidence: 0 };

    let score = 0;
    let maxScore = 0;
    maxScore += 3;
    if (input.target.role) score += input.target.role === info.role ? 3 : (input.semanticTarget?.roles?.includes(info.role) ? 2 : 0);
    else if (input.semanticTarget?.roles?.includes(info.role)) score += 3;
    maxScore += 3;
    if (input.target.nameHash) {
        if ((info.label ? hashField(info.label) : null) === input.target.nameHash) score += 3;
    } else if (input.target.name) {
        if (new RegExp(escapeForRegExp(input.target.name), 'i').test(info.label)) score += 3;
    } else if (input.semanticTarget?.names?.some((pattern) => patternMatches(pattern, info.label))) score += 3;
    maxScore += 2;
    score += input.semanticTarget?.excludeNames?.some((pattern) => patternMatches(pattern, info.label)) ? -2 : 2;
    maxScore += 2;
    if (input.actionKind === 'fill') {
        if (info.isEditable || info.tagName === 'textarea' || info.tagName === 'input') score += 2;
    } else if (input.actionKind === 'click' && (info.tagName === 'button' || info.tagName === 'a' || info.role === 'button')) score += 2;
    const confidence = maxScore > 0 ? score / maxScore : 1;
    if (confidence < VALIDATION_THRESHOLD) return { ok: false, reason: VALIDATION_REASONS.LOW_CONFIDENCE, confidence };
    return { ok: true, confidence };
}

function isRegistryStale(registry: RefRegistry | null | undefined): boolean {
    return !registry || registry.stale === true;
}

async function resolveRef(registry: RefRegistry, ref: string): Promise<TargetCandidate> {
    const normalized = ref.startsWith('@') ? ref : `@${ref}`;
    const entry = registry.refs?.[normalized];
    if (!entry) throw new WebAiError({ errorCode: 'snapshot.ref-not-found', stage: 'snapshot-ref-resolve', retryHint: 're-snapshot', message: `ref ${normalized} not found`, evidence: { ref: normalized } });
    return entry;
}

function targetMatchesRef(target: SemanticTarget, ref: SnapshotRef): boolean {
    if (target.roles?.length && !target.roles.includes(ref.role || '')) return false;
    const name = ref.name || '';
    if (target.excludeNames?.some((pattern) => patternMatches(pattern, name))) return false;
    if (target.names?.length && !target.names.some((pattern) => patternMatches(pattern, name))) return false;
    return true;
}

function scoreCandidate(candidate: { role?: string; name?: string }, target: SemanticTarget): number {
    let score = 0;
    if (target.roles?.includes(candidate.role || '')) score += 2;
    if (target.names?.some((pattern) => patternMatches(pattern, candidate.name || ''))) score += 2;
    if (target.required) score += 1;
    return score;
}

function patternMatches(pattern: RegExp | string, value: unknown): boolean {
    const text = String(value || '');
    if (pattern instanceof RegExp) {
        pattern.lastIndex = 0;
        return pattern.test(text);
    }
    return text.toLowerCase().includes(String(pattern).toLowerCase());
}

function hashField(value: unknown): string {
    return `sha256:${createHash('sha256').update(String(value)).digest('hex').slice(0, 12)}`;
}

function escapeForRegExp(str: unknown): string {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
