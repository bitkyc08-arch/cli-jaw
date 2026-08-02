// ─── Slack Web API Client ────────────────────────────
// Thin fetch wrapper. No SDK: Slack's HTTP surface is small and cli-jaw's
// Discord transport already establishes the house pattern (REST via fetch,
// lazily imported). See devlog/_plan/260802_slack_channel/000_plan.md D-1.
//
// The critical Slack-specific rule: Slack returns HTTP 200 with
// {"ok": false, "error": "..."} for application errors. Checking response.ok
// alone silently swallows every auth, scope, and argument failure.

import { log } from '../core/logger.js';

const SLACK_API_BASE = 'https://slack.com/api';

export type SlackApiResult<T = Record<string, unknown>> = {
    ok: boolean;
    error?: string;
    status?: number;
    data?: T;
};

/** Errors that justify a retry rather than surfacing to the user. */
const RETRYABLE_SLACK_ERRORS = new Set([
    'ratelimited',
    'service_unavailable',
    'internal_error',
    'request_timeout',
    'fatal_error',
]);

export function isRetryableSlackError(error: string | undefined): boolean {
    return !!error && RETRYABLE_SLACK_ERRORS.has(error);
}

/** Map a Slack error code to an actionable operator message. */
export function describeSlackError(error: string | undefined): string {
    switch (error) {
        case 'invalid_auth':
        case 'not_authed':
            return 'Slack token is invalid or missing (check the bot token, xoxb-...)';
        case 'account_inactive':
            return 'Slack bot token belongs to a deactivated app or workspace';
        case 'missing_scope':
            return 'Slack app is missing a required OAuth scope — reinstall the app after adding it';
        case 'channel_not_found':
            return 'Slack conversation not found, or the bot is not a member of it';
        case 'not_in_channel':
            return 'Slack bot is not in that channel — invite it first (/invite @bot)';
        case 'is_archived':
            return 'Slack conversation is archived';
        case 'msg_too_long':
            return 'Slack message exceeded the length limit after chunking';
        case 'ratelimited':
            return 'Slack rate limit hit — retry shortly';
        default:
            return error ? `Slack API error: ${error}` : 'Unknown Slack API error';
    }
}

/**
 * Redact Slack credentials from any string before it reaches a log sink or an
 * API response. Covers two distinct secret shapes:
 *   - bearer tokens (xoxb-, xoxp-, xapp-, ...)
 *   - presigned upload URLs, whose query string IS the capability — anyone
 *     holding it can upload for the duration of its signature
 */
export function redactSlackTokens(input: string): string {
    return input
        .replace(/x(?:ox[bpas]|app)-[A-Za-z0-9-]+/g, (m) => `${m.slice(0, 9)}...redacted`)
        // Any URL carrying a query string may carry a signature; keep the
        // origin+path for debuggability, drop the credential material.
        .replace(/(https?:\/\/[^\s?]+)\?[^\s]*/g, '$1?...redacted');
}

export type SlackFetch = typeof fetch;

/**
 * Build a failure result without emitting explicit `undefined` members.
 * The repo runs `exactOptionalPropertyTypes`, so `{ status: undefined }` is not
 * assignable to `{ status?: number }` — the key has to be absent instead.
 */
export function slackFailure(error: string, status?: number): { ok: false; error: string; status?: number } {
    return status === undefined ? { ok: false, error } : { ok: false, error, status };
}

/**
 * Call a Slack Web API method.
 * `fetchImpl` is injectable so tests capture payloads without a workspace.
 *
 * Every method used by this transport is POST. Some Slack methods (notably
 * files.getUploadURLExternal) take form-encoded arguments rather than JSON,
 * which is what `form: true` selects — NOT a GET request.
 */
export async function slackApi<T = Record<string, unknown>>(
    token: string,
    method: string,
    body?: Record<string, unknown>,
    options: { fetchImpl?: SlackFetch; form?: boolean } = {},
): Promise<SlackApiResult<T>> {
    const doFetch = options.fetchImpl || fetch;
    const url = `${SLACK_API_BASE}/${method}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    const init: RequestInit = { method: 'POST', headers };
    if (options.form && body) {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(body)) {
            if (v !== undefined && v !== null) params.set(k, String(v));
        }
        headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8';
        init.body = params.toString();
    } else if (body) {
        headers['Content-Type'] = 'application/json; charset=utf-8';
        init.body = JSON.stringify(body);
    }

    try {
        const response = await doFetch(url, init);
        const text = await response.text();
        let parsed: Record<string, unknown> = {};
        try {
            parsed = text ? JSON.parse(text) as Record<string, unknown> : {};
        } catch {
            return { ok: false, error: 'invalid_json_response', status: response.status };
        }
        // Slack signals application errors with HTTP 200 + ok:false.
        if (parsed['ok'] !== true) {
            const err = typeof parsed['error'] === 'string' ? parsed['error'] : 'unknown_error';
            log.warn('[slack:api]', redactSlackTokens(`${method} failed: ${err}`));
            return { ok: false, error: err, status: response.status, data: parsed as T };
        }
        return { ok: true, status: response.status, data: parsed as T };
    } catch (error) {
        return {
            ok: false,
            error: redactSlackTokens((error as Error).message),
            status: 502,
        };
    }
}
