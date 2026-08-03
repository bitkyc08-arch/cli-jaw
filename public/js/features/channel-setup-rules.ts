// ── Channel "configured?" rules (data-only) ──
// Kept import-free and DOM-free so unit tests can pull them without the
// help-dialog module graph — same separation as help-content vs help-dialog.
//
// The rules mirror doctor's hard failures, NOT its warnings: telegram needs
// a token; discord needs token + guildId (doctor additionally hard-fails on
// missing channelIds, but the popup targets zero-credentials, not partial
// config — guild+token is enough to receive); slack needs only botToken —
// a missing appToken is outbound-only, a legitimate state the doctor WARNs
// about rather than fails.

export function isTelegramConfigured(token: string): boolean {
    return token.trim().length > 0;
}

export function isDiscordConfigured(token: string, guildId: string): boolean {
    return token.trim().length > 0 && guildId.trim().length > 0;
}

export function isSlackConfigured(botToken: string): boolean {
    return botToken.trim().length > 0;
}

// Token-shape hints for inline field validation. Prefixes are how Slack
// namespaces its tokens; a wrong prefix is almost always a swapped paste.
export function hasSlackBotTokenPrefix(token: string): boolean {
    return token.trim().startsWith('xoxb-');
}

export function hasSlackAppTokenPrefix(token: string): boolean {
    return token.trim().startsWith('xapp-');
}
