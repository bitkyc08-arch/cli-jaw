import { DASHBOARD_DEFAULT_PORT } from '../manager/constants.js';

/**
 * SSRF guard for the hub callback URL (P2b hub-member outbound). Only a loopback
 * http origin is accepted; a non-loopback host, https, credentials, or garbage all
 * fall back to the safe local default. Returns just the origin (`http://host:port`).
 */
export function resolveHubCallback(configured?: unknown): string {
    const fallback = `http://127.0.0.1:${DASHBOARD_DEFAULT_PORT}`;
    const raw = (typeof configured === 'string' && configured)
        ? configured
        : (process.env["JAW_HUB_CALLBACK_URL"] || fallback);
    try {
        const u = new URL(raw);
        const loopback = u.hostname === '127.0.0.1' || u.hostname === '::1' || u.hostname === 'localhost';
        if (u.protocol === 'http:' && loopback && !u.username && !u.password) return `${u.protocol}//${u.host}`;
    } catch { /* fall through to safe default */ }
    return fallback;
}
