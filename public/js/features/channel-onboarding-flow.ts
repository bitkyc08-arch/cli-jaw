// ── Channel onboarding flow: pure state machine ──
// Four steps for every channel (안내 → 입력 → 검증 → 저장), so the popup can
// show "2/4" honestly and refuse to advance until THAT step's own contract is
// satisfied. Kept DOM-free and import-free so every gate below is unit-tested
// without a browser — the UI module owns rendering only.
//
// Draft values live here and survive step movement in both directions: a user
// who goes back to fix a typo must not lose the token they already pasted.

export type OnboardChannel = 'telegram' | 'discord' | 'slack';

export type FieldDef = {
    /** Payload key sent to the validate route and the settings patch. */
    key: string;
    /** Matching input id in the settings section, for value mirroring. */
    settingsId: string;
    secret: boolean;
    optional?: boolean;
    /** Required prefix, when the provider namespaces its tokens. */
    prefix?: string;
    /** Illustrative shape shown as the input placeholder — never a real value. */
    example: string;
};

export const CHANNEL_FIELDS: Record<OnboardChannel, readonly FieldDef[]> = {
    telegram: [
        { key: 'botToken', settingsId: 'tgToken', secret: true, example: '8123456789:AAH...' },
    ],
    discord: [
        { key: 'botToken', settingsId: 'dcToken', secret: true, example: 'MTIzNDU2Nzg5...' },
        { key: 'guildId', settingsId: 'dcGuildId', secret: false, example: '123456789012345678' },
    ],
    slack: [
        { key: 'botToken', settingsId: 'slBotToken', secret: true, prefix: 'xoxb-', example: 'xoxb-1234-5678-abcd...' },
        { key: 'appToken', settingsId: 'slAppToken', secret: true, optional: true, prefix: 'xapp-', example: 'xapp-1-A01...' },
    ],
};

/** Where each channel issues its credentials — the step-1 primary action. */
export const ISSUER_URLS: Record<OnboardChannel, string> = {
    telegram: 'https://t.me/BotFather',
    discord: 'https://discord.com/developers/applications',
    slack: 'https://api.slack.com/apps',
};

export const TOTAL_STEPS = 4;
/** 1 = 안내, 2 = 자격 증명 입력, 3 = 연결 검증, 4 = 저장 완료. */
export type StepIndex = 1 | 2 | 3 | 4;

export type Draft = Record<string, string>;

export type FlowState = {
    channel: OnboardChannel;
    step: StepIndex;
    draft: Draft;
    /** Set once step 3 passes; cleared whenever a credential changes. */
    validatedIdentity: string | null;
    validatedTeamId: string;
    /** i18n key suffix for the blocking reason, or null when the step is clear. */
    error: string | null;
    /** Scopes the provider reported as missing, shown with the error. */
    missingScopes: string[];
    /** Optional feature scopes; warnings only, never a step-3 blocker. */
    missingCapabilities: string[];
    saved: boolean;
};

export function createFlow(channel: OnboardChannel, draft: Draft = {}): FlowState {
    return {
        channel,
        step: 1,
        draft: { ...draft },
        validatedIdentity: null,
        validatedTeamId: '',
        error: null,
        missingScopes: [],
        missingCapabilities: [],
        saved: false,
    };
}

export function fieldsFor(channel: OnboardChannel): readonly FieldDef[] {
    return CHANNEL_FIELDS[channel];
}

/**
 * Local (offline) contract for the credential step: required fields present
 * and prefixes correct. This runs BEFORE the network call so a swapped paste
 * costs zero requests, and it is the same rule the CLI wizard enforces.
 */
export function checkCredentials(channel: OnboardChannel, draft: Draft): string | null {
    for (const field of fieldsFor(channel)) {
        const value = (draft[field.key] || '').trim();
        if (!value) {
            if (field.optional) continue;
            return field.key === 'guildId' ? 'guild_required' : 'token_required';
        }
        if (field.prefix && !value.startsWith(field.prefix)) {
            return field.key === 'appToken' ? 'app_prefix' : 'bot_prefix';
        }
    }
    return null;
}

/** Why the given step cannot be left yet, or null when it may advance. */
export function blockerForStep(state: FlowState): string | null {
    if (state.step === 1) return null;
    if (state.step === 2) return checkCredentials(state.channel, state.draft);
    if (state.step === 3) return state.validatedIdentity ? null : 'validation_required';
    return null;
}

export function canAdvance(state: FlowState): boolean {
    return state.step < TOTAL_STEPS && blockerForStep(state) === null;
}

/** Move forward one step, or record why it is blocked. Never skips a gate. */
export function advance(state: FlowState): FlowState {
    if (state.step >= TOTAL_STEPS) return state;
    const blocker = blockerForStep(state);
    if (blocker) return { ...state, error: blocker };
    return { ...state, step: (state.step + 1) as StepIndex, error: null };
}

/** Move back one step. Draft and validation results are preserved. */
export function goBack(state: FlowState): FlowState {
    if (state.step <= 1) return state;
    return { ...state, step: (state.step - 1) as StepIndex, error: null };
}

/**
 * Record a credential edit. Any change invalidates a previous validation:
 * otherwise a user could validate a good token, paste a bad one, and still
 * reach the save step on the stale pass.
 */
export function setField(state: FlowState, key: string, value: string): FlowState {
    if ((state.draft[key] ?? '') === value) return state;
    return {
        ...state,
        draft: { ...state.draft, [key]: value },
        validatedIdentity: null,
        validatedTeamId: '',
        error: null,
        missingScopes: [],
        missingCapabilities: [],
    };
}

export function applyValidation(
    state: FlowState,
    result: {
        ok?: boolean;
        identity?: string;
        teamId?: string;
        error?: string;
        missing?: string[];
        missingCapabilities?: string[];
    },
): FlowState {
    if (result?.ok) {
        return {
            ...state,
            validatedIdentity: result.identity || 'ok',
            validatedTeamId: result.teamId || '',
            error: null,
            missingScopes: [],
            missingCapabilities: Array.isArray(result.missingCapabilities)
                ? result.missingCapabilities
                : [],
        };
    }
    return {
        ...state,
        validatedIdentity: null,
        validatedTeamId: '',
        error: result?.error || 'network',
        missingScopes: Array.isArray(result?.missing) ? result.missing : [],
        missingCapabilities: [],
    };
}

export function markSaved(state: FlowState): FlowState {
    return { ...state, saved: true, step: TOTAL_STEPS, error: null };
}

/** Payload for POST /api/channels/validate. */
export function validationPayload(state: FlowState): Record<string, string> {
    const payload: Record<string, string> = { channel: state.channel };
    for (const field of fieldsFor(state.channel)) {
        payload[field.key] = (state.draft[field.key] || '').trim();
    }
    return payload;
}

/** Settings patch for PUT /api/settings, shaped per channel. */
export function settingsPatch(state: FlowState): Record<string, unknown> {
    const value = (key: string): string => (state.draft[key] || '').trim();
    if (state.channel === 'telegram') {
        return { telegram: { enabled: true, token: value('botToken') } };
    }
    if (state.channel === 'discord') {
        return { discord: { enabled: true, token: value('botToken'), guildId: value('guildId') } };
    }
    return {
        slack: {
            enabled: true,
            botToken: value('botToken'),
            appToken: value('appToken'),
            ...(state.validatedTeamId ? { teamId: state.validatedTeamId } : {}),
        },
    };
}
