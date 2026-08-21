// ─── Live channel credential validation ─────────────
// Backs the onboarding wizard's "검증" button. Each channel maps to the
// cheapest authoritative call: telegram getMe, discord users/@me, slack
// auth.test (+ apps.connections.open when an app token is present).
// Tokens never touch logs or error payloads — error strings are generic.
export type ChannelValidateRequest = {
    channel?: string;
    botToken?: string;
    appToken?: string;
    guildId?: string;
};

export type ChannelValidateResult = {
    ok: boolean;
    identity?: string;
    teamId?: string;
    error?: string;
    /** Bot scopes the app still needs, when the token is otherwise valid. */
    missing?: string[];
    /** Optional feature scopes whose absence does not block text messaging. */
    missingCapabilities?: string[];
};

/**
 * Bot scopes the transport actually calls. A token missing any of these looks
 * fine at auth.test and then fails at the first real use — exactly how a DOCX
 * upload died on `missing_scope` after setup "succeeded". Slack returns the
 * granted set in the `x-oauth-scopes` response header, so the gap is knowable
 * at setup time.
 */
export const REQUIRED_SLACK_BOT_SCOPES = [
    'app_mentions:read',
    'channels:history',
    'groups:history',
    'im:history',
    'im:write',
    'chat:write',
    'files:write',
    'commands',
] as const;

/**
 * Optional scopes. Absence disables a feature but never blocks text messaging,
 * which is why the identity/roster scopes live here rather than in the required
 * list: promoting them would mark every existing install as broken, when in fact
 * sender names simply fall back to raw ids until the app is reinstalled.
 */
export const SLACK_CAPABILITY_SCOPES = [
    // reactions:write is optional on purpose: promoting it to required would mark
    // every existing install broken over an opt-in acknowledgement feature.
    'reactions:write',
    // conversations.join -> auto-join public channels at boot. A bot token gets
    // not_in_channel from conversations.history unless it is a member, so this
    // is the only supported route to reading a channel nobody invited us to.
    'channels:join',
    // chat.postMessage into a public channel the bot has NOT joined. Redundant
    // once a join succeeds, which is exactly why it is not required: auto-join
    // can be off, budget-capped, still running, or refused for one channel, and
    // outbound should not wait for membership in any of those cases.
    'chat:write.public',
    'files:read',
    'users:read', 'team:read',
    'channels:read', 'groups:read', 'im:read', 'mpim:read',
] as const;

/** Scopes required but not granted, in required-list order. */
export function missingSlackScopes(grantedHeader: string | null | undefined): string[] {
    // An absent header means Slack did not tell us; treat it as "cannot check"
    // rather than "everything is missing".
    if (!grantedHeader) return [];
    const granted = new Set(grantedHeader.split(',').map(s => s.trim()).filter(Boolean));
    return REQUIRED_SLACK_BOT_SCOPES.filter(scope => !granted.has(scope));
}

export function missingSlackCapabilityScopes(grantedHeader: string | null | undefined): string[] {
    if (!grantedHeader) return [];
    const granted = new Set(grantedHeader.split(',').map(s => s.trim()).filter(Boolean));
    return SLACK_CAPABILITY_SCOPES.filter(scope => !granted.has(scope));
}

export async function validateChannelCredentials(
    req: ChannelValidateRequest,
    fetchImpl: typeof fetch = fetch,
): Promise<ChannelValidateResult> {
    const channel = String(req.channel || '');
    const botToken = String(req.botToken || '').trim();
    if (!botToken) return { ok: false, error: 'token_required' };

    try {
        if (channel === 'telegram') {
            const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/getMe`,
                { signal: AbortSignal.timeout(8000) });
            const json = await res.json() as { ok?: boolean; result?: { username?: string } };
            if (!json.ok) return { ok: false, error: 'invalid_token' };
            return { ok: true, identity: `@${json.result?.username || 'bot'}` };
        }
        if (channel === 'discord') {
            const res = await fetchImpl('https://discord.com/api/v10/users/@me', {
                headers: { Authorization: `Bot ${botToken}` },
                signal: AbortSignal.timeout(8000),
            });
            if (!res.ok) return { ok: false, error: 'invalid_token' };
            const json = await res.json() as { username?: string };
            if (!String(req.guildId || '').trim()) return { ok: false, error: 'guild_required' };
            return { ok: true, identity: json.username || 'bot' };
        }
        if (channel === 'slack') {
            if (!botToken.startsWith('xoxb-')) return { ok: false, error: 'bot_prefix' };
            const post = (method: string, token: string) => fetchImpl(`https://slack.com/api/${method}`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(8000),
            });
            const authRes = await post('auth.test', botToken);
            const auth = await authRes.json() as { ok?: boolean; team_id?: string; user?: string };
            if (!auth.ok) return { ok: false, error: 'invalid_token' };
            // Catch a scope gap HERE rather than at the first upload/post.
            const missing = missingSlackScopes(authRes.headers?.get?.('x-oauth-scopes'));
            if (missing.length) return { ok: false, error: 'missing_scopes', missing };
            const missingCapabilities = missingSlackCapabilityScopes(authRes.headers?.get?.('x-oauth-scopes'));
            const appToken = String(req.appToken || '').trim();
            if (appToken) {
                if (!appToken.startsWith('xapp-')) return { ok: false, error: 'app_prefix' };
                const connRes = await post('apps.connections.open', appToken);
                const conn = await connRes.json() as { ok?: boolean };
                if (!conn.ok) return { ok: false, error: 'invalid_app_token' };
            }
            return {
                ok: true,
                identity: auth.user || 'bot',
                ...(auth.team_id ? { teamId: auth.team_id } : {}),
                ...(missingCapabilities.length ? { missingCapabilities } : {}),
            };
        }
        return { ok: false, error: 'unknown_channel' };
    } catch {
        return { ok: false, error: 'network' };
    }
}
