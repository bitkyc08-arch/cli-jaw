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
};

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
            const appToken = String(req.appToken || '').trim();
            if (appToken) {
                if (!appToken.startsWith('xapp-')) return { ok: false, error: 'app_prefix' };
                const connRes = await post('apps.connections.open', appToken);
                const conn = await connRes.json() as { ok?: boolean };
                if (!conn.ok) return { ok: false, error: 'invalid_app_token' };
            }
            return { ok: true, identity: auth.user || 'bot', ...(auth.team_id ? { teamId: auth.team_id } : {}) };
        }
        return { ok: false, error: 'unknown_channel' };
    } catch {
        return { ok: false, error: 'network' };
    }
}
