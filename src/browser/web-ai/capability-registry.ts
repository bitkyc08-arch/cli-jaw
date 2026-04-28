/**
 * PRD32.3 — Oracle Browser Parity Capability Registry
 *
 * Single source of truth for what the cli-jaw web-ai layer claims about each
 * Oracle browser capability. Every entry must be either implemented, planned,
 * fail-closed, or out-of-scope. The registry is fail-closed by default: any
 * lookup of an unknown capability returns `unknown` and callers must reject
 * before any browser mutation.
 */

export type WebAiVendorScope = 'chatgpt' | 'gemini' | 'shared';

export type CapabilityStatus =
    | 'implemented-30_browser'
    | 'ported-cli-jaw'
    | 'planned'
    | 'fail-closed'
    | 'rejected-until-verified'
    | 'deferred'
    | 'out-of-scope'
    | 'unknown';

export interface CapabilityEntry {
    /** Stable id, lowercase kebab. */
    id: string;
    /** Vendor scope this entry applies to. */
    vendor: WebAiVendorScope;
    /** Current status in cli-jaw. */
    status: CapabilityStatus;
    /** PRD32.n that owns this capability (or '32.3' for the registry itself). */
    ownerPrd: string;
    /** What the public command should currently do. */
    commandBehavior: string;
    /** Whether browser mutation is allowed today. */
    browserMutationAllowed: boolean;
    /** Stage at which to fail closed when not yet implemented. */
    failClosedStage?: string;
    /** Required official docs URLs. */
    requiredOfficialDocs: string[];
    /** Whether 30_browser already has this. */
    browserGate: 'present' | 'partial' | 'absent';
    /** Whether cli-jaw has ported this. */
    cliJawPortGate: 'present' | 'partial' | 'absent';
}

/**
 * Authoritative registry. Order is documentation-meaningful: it mirrors the
 * Oracle 2nd-audit implementation order from PRD32.3. Do not reorder without
 * updating the PRD.
 */
const REGISTRY: CapabilityEntry[] = [
    {
        id: 'chatgpt-question-envelope',
        vendor: 'chatgpt',
        status: 'ported-cli-jaw',
        ownerPrd: '32.1/32.2',
        commandBehavior: 'render and insert a structured envelope before browser mutation',
        browserMutationAllowed: true,
        requiredOfficialDocs: ['https://help.openai.com/en/articles/8983675'],
        browserGate: 'present',
        cliJawPortGate: 'present',
    },
    {
        id: 'chatgpt-active-tab-verification',
        vendor: 'chatgpt',
        status: 'ported-cli-jaw',
        ownerPrd: '32.6',
        commandBehavior: 'fail closed when active tab is not a verified ChatGPT tab',
        browserMutationAllowed: false,
        failClosedStage: 'status',
        requiredOfficialDocs: [],
        browserGate: 'present',
        cliJawPortGate: 'present',
    },
    {
        id: 'chatgpt-composer-insert',
        vendor: 'chatgpt',
        status: 'ported-cli-jaw',
        ownerPrd: '32.1/32.2',
        commandBehavior: 'insert prompt into composer and verify commit',
        browserMutationAllowed: true,
        requiredOfficialDocs: ['https://help.openai.com/en/articles/8983675'],
        browserGate: 'present',
        cliJawPortGate: 'present',
    },
    {
        id: 'chatgpt-send-button',
        vendor: 'chatgpt',
        status: 'ported-cli-jaw',
        ownerPrd: '32.2',
        commandBehavior: 'click enabled send button via trusted path',
        browserMutationAllowed: true,
        requiredOfficialDocs: [],
        browserGate: 'present',
        cliJawPortGate: 'present',
    },
    {
        id: 'chatgpt-prompt-commit',
        vendor: 'chatgpt',
        status: 'ported-cli-jaw',
        ownerPrd: '32.4/32.6',
        commandBehavior: 'verify committed turn count after submit',
        browserMutationAllowed: true,
        requiredOfficialDocs: [],
        browserGate: 'present',
        cliJawPortGate: 'present',
    },
    {
        id: 'chatgpt-answer-polling',
        vendor: 'chatgpt',
        status: 'planned',
        ownerPrd: '32.4',
        commandBehavior: 'capture only assistant turn after committed baseline',
        browserMutationAllowed: false,
        failClosedStage: 'poll-timeout',
        requiredOfficialDocs: ['https://help.openai.com/en/articles/8983675'],
        browserGate: 'partial',
        cliJawPortGate: 'partial',
    },
    {
        id: 'chatgpt-stop-generation',
        vendor: 'chatgpt',
        status: 'planned',
        ownerPrd: '32.4',
        commandBehavior: 'press Escape on verified target session only',
        browserMutationAllowed: true,
        requiredOfficialDocs: [],
        browserGate: 'partial',
        cliJawPortGate: 'partial',
    },
    {
        id: 'chatgpt-copy-markdown-fallback',
        vendor: 'chatgpt',
        status: 'planned',
        ownerPrd: '32.4',
        commandBehavior: 'opt-in, post-completion only, recorded in usedFallbacks',
        browserMutationAllowed: false,
        failClosedStage: 'poll-timeout',
        requiredOfficialDocs: [],
        browserGate: 'absent',
        cliJawPortGate: 'absent',
    },
    {
        id: 'web-ai-failure-diagnostics',
        vendor: 'shared',
        status: 'planned',
        ownerPrd: '32.5',
        commandBehavior: 'return redacted diagnostics envelope on every failure',
        browserMutationAllowed: false,
        requiredOfficialDocs: [],
        browserGate: 'partial',
        cliJawPortGate: 'partial',
    },
    {
        id: 'web-ai-session-lifecycle',
        vendor: 'shared',
        status: 'planned',
        ownerPrd: '32.6',
        commandBehavior: 'persist sessionId/targetId/baseline; reattach safely',
        browserMutationAllowed: false,
        requiredOfficialDocs: [],
        browserGate: 'partial',
        cliJawPortGate: 'partial',
    },
    {
        id: 'chatgpt-attachment-policy',
        vendor: 'chatgpt',
        status: 'fail-closed',
        ownerPrd: '32.7',
        commandBehavior: 'reject --file before any browser mutation',
        browserMutationAllowed: false,
        failClosedStage: 'attachment-preflight',
        requiredOfficialDocs: [
            'https://help.openai.com/en/articles/8983675',
            'https://help.openai.com/en/articles/8555545-file-uploads-with-gpts-and-advanced-data-analysis-in-chatgpt',
        ],
        browserGate: 'absent',
        cliJawPortGate: 'absent',
    },
    {
        id: 'chatgpt-file-input',
        vendor: 'chatgpt',
        status: 'fail-closed',
        ownerPrd: '32.7',
        commandBehavior: 'composer-scoped file input not enabled until 32.7-B',
        browserMutationAllowed: false,
        failClosedStage: 'attachment-preflight',
        requiredOfficialDocs: [],
        browserGate: 'absent',
        cliJawPortGate: 'absent',
    },
    {
        id: 'chatgpt-upload-chip-wait',
        vendor: 'chatgpt',
        status: 'fail-closed',
        ownerPrd: '32.7',
        commandBehavior: 'visible chip + accepted state required',
        browserMutationAllowed: false,
        failClosedStage: 'attachment-upload',
        requiredOfficialDocs: [],
        browserGate: 'absent',
        cliJawPortGate: 'absent',
    },
    {
        id: 'chatgpt-sent-turn-attachment-evidence',
        vendor: 'chatgpt',
        status: 'fail-closed',
        ownerPrd: '32.7',
        commandBehavior: 'sent user-turn must include attachment evidence',
        browserMutationAllowed: false,
        failClosedStage: 'attachment-upload',
        requiredOfficialDocs: [],
        browserGate: 'absent',
        cliJawPortGate: 'absent',
    },
    {
        id: 'web-ai-model-selection',
        vendor: 'shared',
        status: 'rejected-until-verified',
        ownerPrd: '32.8/32.9',
        commandBehavior: 'reject --model; provider-specific only',
        browserMutationAllowed: false,
        requiredOfficialDocs: [],
        browserGate: 'absent',
        cliJawPortGate: 'absent',
    },
    {
        id: 'gemini-deep-think',
        vendor: 'gemini',
        status: 'fail-closed',
        ownerPrd: '32.8',
        commandBehavior: 'contract-only; mutation rejects before browser action',
        browserMutationAllowed: false,
        failClosedStage: 'provider-select-mode',
        requiredOfficialDocs: ['https://support.google.com/gemini/answer/16345172'],
        browserGate: 'absent',
        cliJawPortGate: 'absent',
    },
    {
        id: 'gemini-file-context',
        vendor: 'gemini',
        status: 'fail-closed',
        ownerPrd: '32.8/32.9',
        commandBehavior: 'separate adapter; no ChatGPT selector reuse',
        browserMutationAllowed: false,
        failClosedStage: 'attachment-preflight',
        requiredOfficialDocs: [
            'https://support.google.com/gemini/answer/14903178',
            'https://support.google.com/gemini/answer/16275805',
        ],
        browserGate: 'absent',
        cliJawPortGate: 'absent',
    },
    {
        id: 'deep-research',
        vendor: 'shared',
        status: 'deferred',
        ownerPrd: '32.9',
        commandBehavior: 'separate state machine; not normal chat',
        browserMutationAllowed: false,
        requiredOfficialDocs: [
            'https://help.openai.com/articles/10500283',
            'https://support.google.com/gemini/answer/15719111',
        ],
        browserGate: 'absent',
        cliJawPortGate: 'absent',
    },
    {
        id: 'chatgpt-projects',
        vendor: 'chatgpt',
        status: 'deferred',
        ownerPrd: '32.9',
        commandBehavior: 'project context metadata only; attachment after 32.7',
        browserMutationAllowed: false,
        requiredOfficialDocs: [
            'https://help.openai.com/en/articles/10169521-using-projects-in-chatgpt',
        ],
        browserGate: 'absent',
        cliJawPortGate: 'absent',
    },
    {
        id: 'chatgpt-library',
        vendor: 'chatgpt',
        status: 'deferred',
        ownerPrd: '32.9',
        commandBehavior: 'detect availability only; no attach until 32.7',
        browserMutationAllowed: false,
        requiredOfficialDocs: [
            'https://help.openai.com/en/articles/20001052-library-for-chatgpt',
        ],
        browserGate: 'absent',
        cliJawPortGate: 'absent',
    },
    {
        id: 'chatgpt-apps-connected-sources',
        vendor: 'chatgpt',
        status: 'deferred',
        ownerPrd: '32.9',
        commandBehavior: 'already-connected only; hard stop on write actions',
        browserMutationAllowed: false,
        requiredOfficialDocs: ['https://help.openai.com/en/articles/11487775'],
        browserGate: 'absent',
        cliJawPortGate: 'absent',
    },
    {
        id: 'chatgpt-canvas-capture',
        vendor: 'chatgpt',
        status: 'deferred',
        ownerPrd: '32.9',
        commandBehavior: 'detect Canvas-opened state; no editing or export',
        browserMutationAllowed: false,
        requiredOfficialDocs: [
            'https://help.openai.com/en/articles/9930697-what-is-the-canvas-feature-in-chatgpt-and-how-do-i-use-it',
        ],
        browserGate: 'absent',
        cliJawPortGate: 'absent',
    },
    {
        id: 'web-ai-captcha-bypass',
        vendor: 'shared',
        status: 'out-of-scope',
        ownerPrd: '32.3',
        commandBehavior: 'never automated; explicitly forbidden',
        browserMutationAllowed: false,
        requiredOfficialDocs: [],
        browserGate: 'absent',
        cliJawPortGate: 'absent',
    },
    {
        id: 'web-ai-cross-vendor-fallback',
        vendor: 'shared',
        status: 'out-of-scope',
        ownerPrd: '32.3',
        commandBehavior: 'forbidden; vendor must be explicit per command',
        browserMutationAllowed: false,
        requiredOfficialDocs: [],
        browserGate: 'absent',
        cliJawPortGate: 'absent',
    },
];

const UNKNOWN: CapabilityEntry = {
    id: 'unknown',
    vendor: 'shared',
    status: 'unknown',
    ownerPrd: '32.3',
    commandBehavior: 'fail closed before any browser mutation',
    browserMutationAllowed: false,
    failClosedStage: 'status',
    requiredOfficialDocs: [],
    browserGate: 'absent',
    cliJawPortGate: 'absent',
};

export function listCapabilities(): readonly CapabilityEntry[] {
    return REGISTRY;
}

export function lookupCapability(id: string): CapabilityEntry {
    const found = REGISTRY.find(entry => entry.id === id);
    return found ? { ...found } : { ...UNKNOWN, id };
}

export function isCapabilityEnabled(id: string): boolean {
    const entry = lookupCapability(id);
    return entry.status === 'implemented-30_browser' || entry.status === 'ported-cli-jaw';
}

export function requireCapabilityOrFailClosed(id: string): CapabilityEntry {
    const entry = lookupCapability(id);
    if (entry.status === 'implemented-30_browser' || entry.status === 'ported-cli-jaw') return entry;
    const stage = entry.failClosedStage || 'status';
    const reason = entry.status === 'unknown'
        ? `unknown capability "${id}"; fail closed`
        : `capability "${id}" is ${entry.status} (PRD${entry.ownerPrd}); not enabled`;
    const error = new Error(`${reason}. stage=${stage}`);
    (error as any).capabilityId = id;
    (error as any).stage = stage;
    (error as any).ownerPrd = entry.ownerPrd;
    throw error;
}

export interface FreshnessGateRecord {
    retrievalDate: string;
    vendorDocsSearched: string[];
    officialSourcesUsed: string[];
    visibleUpdatedDates: Record<string, string>;
    featureChangesSincePriorPrd: string[];
    contradictionsOrUnstableLimits: string[];
    uiAuthoritativeForPlanLimits: boolean;
    implementationImpact: string[];
    testsUpdatedBecauseOfDocs: string[];
}

/**
 * Validate a freshness gate record. Throws when required fields are missing.
 * Used by PRD-touching code paths to make sure no implementation lands without
 * an official-docs review trail.
 */
export function validateFreshnessGate(record: Partial<FreshnessGateRecord>): FreshnessGateRecord {
    const required: (keyof FreshnessGateRecord)[] = [
        'retrievalDate',
        'vendorDocsSearched',
        'officialSourcesUsed',
        'visibleUpdatedDates',
        'featureChangesSincePriorPrd',
        'contradictionsOrUnstableLimits',
        'uiAuthoritativeForPlanLimits',
        'implementationImpact',
        'testsUpdatedBecauseOfDocs',
    ];
    for (const key of required) {
        if (record[key] === undefined || record[key] === null) {
            throw new Error(`freshness gate missing field: ${String(key)}`);
        }
    }
    if (!Array.isArray(record.officialSourcesUsed) || record.officialSourcesUsed.length === 0) {
        throw new Error('freshness gate requires at least one official source');
    }
    if (!record.uiAuthoritativeForPlanLimits) {
        throw new Error('freshness gate requires uiAuthoritativeForPlanLimits=true');
    }
    return record as FreshnessGateRecord;
}
