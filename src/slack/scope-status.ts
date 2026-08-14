// ─── Slack OAuth scope drift ────────────────────────
// A Slack app created from an older cli-jaw manifest keeps its original grant
// forever. Adding a scope to `manifest.ts` changes what NEW apps get; it does
// nothing for an app already installed. The transport then connects, health
// reports ok, messages are answered — and every users.info/conversations.info
// call fails with missing_scope, so senders degrade to raw ids.
//
// The gap is knowable for free: Slack returns the token's whole granted set in
// the `x-oauth-scopes` header of every Web API response, and the transport
// already calls auth.test on every start. This module owns the resulting state
// so doctor, /api/health and the identity warning all read one answer instead
// of computing three.
//
// Reported as #340.
import {
    missingSlackScopes,
    missingSlackCapabilityScopes,
} from '../messaging/channel-validate.js';

export type SlackScopeStatus = {
    /** False only when a check actually ran and found a gap. */
    ok: boolean;
    /**
     * True when no `x-oauth-scopes` has ever been observed, so the answer is
     * "cannot check" rather than "nothing missing". Kept separate from `ok`
     * so a header-stripping proxy cannot masquerade as a clean bill of health.
     */
    unknown: boolean;
    /** Missing scopes the transport genuinely needs, in required-list order. */
    missingRequired: string[];
    /** Missing scopes that degrade a feature without breaking messaging. */
    missingCapabilities: string[];
    /** Reinstall URL when the app id is known; null otherwise. */
    reinstallUrl: string | null;
    /** Epoch ms of the last observation, or null if never observed. */
    checkedAt: number | null;
};

const UNOBSERVED: SlackScopeStatus = {
    ok: true,
    unknown: true,
    missingRequired: [],
    missingCapabilities: [],
    reinstallUrl: null,
    checkedAt: null,
};

let current: SlackScopeStatus = { ...UNOBSERVED };

/**
 * Record what Slack said about this token's grant.
 *
 * `granted` is the raw header. `undefined` leaves the status unknown rather
 * than clearing it: not observing a thing is not evidence about the thing.
 */
export function recordSlackScopeObservation(
    granted: string | undefined,
    appId?: string | null,
): void {
    if (!granted) {
        current = {
            ...UNOBSERVED,
            reinstallUrl: slackReinstallUrl(appId),
        };
        return;
    }
    const missingRequired = missingSlackScopes(granted);
    const missingCapabilities = missingSlackCapabilityScopes(granted);
    current = {
        ok: missingRequired.length === 0 && missingCapabilities.length === 0,
        unknown: false,
        missingRequired,
        missingCapabilities,
        reinstallUrl: slackReinstallUrl(appId),
        checkedAt: Date.now(),
    };
}

export function getSlackScopeStatus(): SlackScopeStatus {
    return { ...current };
}

/** A re-init may authenticate against a different workspace. */
export function resetSlackScopeStatus(): void {
    current = { ...UNOBSERVED };
}

/**
 * Slack does not return the app id from auth.test, so this is null for most
 * installs. An invented URL is worse than none — a wrong app id sends the
 * operator to someone else's app — so the caller falls back to prose.
 */
function slackReinstallUrl(appId?: string | null): string | null {
    const id = String(appId ?? '').trim();
    if (!id) return null;
    return `https://api.slack.com/apps/${id}/install-on-team`;
}

/**
 * One operator-facing line naming every missing scope at once, or null when
 * there is nothing to say. Returning null for the unknown case is deliberate:
 * a warning that fires when we did not measure anything trains people to
 * ignore warnings.
 */
export function describeSlackScopeGap(status: SlackScopeStatus): string | null {
    if (status.unknown) return null;
    const missing = [...status.missingRequired, ...status.missingCapabilities];
    if (missing.length === 0) return null;
    const where = status.reinstallUrl
        ? `reinstall: ${status.reinstallUrl}`
        : 'add them under OAuth & Permissions, then reinstall the app to your workspace';
    const severity = status.missingRequired.length > 0
        ? 'the transport needs'
        : 'features degrade without';
    return `Slack app grant is missing ${missing.length} scope(s) — `
        + `${severity}: ${missing.join(', ')} — ${where}`;
}
