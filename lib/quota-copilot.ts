// ─── Copilot Quota: copilot_internal/user API via keychain ──────
// Token source: macOS keychain service "copilot-cli"
// Cached to file (~/.cli-jaw/auth/copilot-token) to avoid repeated keychain popups.
// If keychain read fails, suppressed until process restart.

import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const JAW_HOME = process.env.CLI_JAW_HOME
    ? path.resolve(process.env.CLI_JAW_HOME.replace(/^~(?=\/|$)/, os.homedir()))
    : path.join(os.homedir(), '.cli-jaw');
const AUTH_DIR = path.join(JAW_HOME, 'auth');
const TOKEN_CACHE_PATH = path.join(AUTH_DIR, 'copilot-token');

let _cachedToken: string | null = null;
let _keychainFailed = false; // suppress retry until restart

function readCopilotConfig(): { login: string; host: string } | null {
    try {
        const cfgPath = path.join(os.homedir(), '.copilot', 'config.json');
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        if (cfg?.last_logged_in_user?.login) {
            return { login: cfg.last_logged_in_user.login, host: cfg.last_logged_in_user.host || 'https://github.com' };
        }
    } catch { /* no copilot config */ }
    return null;
}

function getCopilotToken() {
    if (_cachedToken) return _cachedToken;

    // ─── 1. Env vars (cross-platform, explicit override) ───
    const envToken =
        process.env.COPILOT_GITHUB_TOKEN ||
        process.env.GH_TOKEN ||
        process.env.GITHUB_TOKEN;
    if (envToken) {
        _cachedToken = envToken;
        return _cachedToken;
    }

    // ─── 2. File cache (no keychain popup) ───
    try {
        if (fs.existsSync(TOKEN_CACHE_PATH)) {
            const cached = fs.readFileSync(TOKEN_CACHE_PATH, 'utf8').trim();
            if (cached) {
                _cachedToken = cached;
                return _cachedToken;
            }
        }
    } catch { /* cache read failed, try keychain */ }

    // ─── 3. macOS Keychain (one-shot, then cache to file) ───
    if (process.platform === 'darwin' && !_keychainFailed) {
        try {
            // Use last_logged_in_user from copilot config for account selection
            const copilotUser = readCopilotConfig();
            const accountArg = copilotUser
                ? `-a "${copilotUser.host}:${copilotUser.login}"`
                : '';

            const token = execSync(
                `security find-generic-password -s "copilot-cli" ${accountArg} -w`,
                { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
            ).trim();

            if (token) {
                _cachedToken = token;
                // Cache to file for future reads
                try {
                    fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
                    fs.writeFileSync(TOKEN_CACHE_PATH, token, { mode: 0o600 });
                } catch (e: unknown) {
                    console.warn('[quota-copilot] token cache write failed:', (e as Error).message);
                }
                return _cachedToken;
            }
        } catch (e: unknown) {
            console.warn('[quota-copilot] keychain read failed (suppressed until restart):', (e as Error).message?.split('\n')[0]);
            _keychainFailed = true; // don't ask again this session
            return null;
        }
    }

    // win32/linux: no keychain CLI — rely on env tokens above
    if (process.env.DEBUG && process.platform !== 'darwin') {
        console.info(`[quota-copilot] token lookup skipped on ${process.platform} (set COPILOT_GITHUB_TOKEN or GH_TOKEN)`);
    }
    return null;
}

export async function fetchCopilotQuota() {
    const token = getCopilotToken();
    if (!token) return null;

    try {
        const res = await fetch('https://api.github.com/copilot_internal/user', {
            headers: {
                'Authorization': `token ${token}`,
                'Editor-Version': 'vscode/1.95.0',
            },
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) {
            // Token expired or invalid → clear cache
            if (res.status === 401 || res.status === 403) {
                clearCopilotTokenCache();
            }
            return null;
        }
        const data = await res.json() as Record<string, any>;

        const snap = data.quota_snapshots || {};
        const pi = snap.premium_interactions || {};
        const windows = [];

        if (!pi.unlimited && pi.entitlement) {
            windows.push({
                label: 'Premium',
                used: pi.entitlement - (pi.remaining ?? pi.entitlement),
                limit: pi.entitlement,
                percent: 100 - (pi.percent_remaining ?? 100),
            });
        }

        return {
            account: {
                email: data.login || null,
                plan: data.access_type_sku?.replace(/_/g, ' ') || data.copilot_plan || null,
            },
            windows,
            resetDate: data.quota_reset_date || null,
        };
    } catch (e: unknown) {
        console.error('[quota-copilot]', (e as Error).message);
        return null;
    }
}

/** Clear cached token (in-memory + file) — e.g. after re-login or token expiry */
export function clearCopilotTokenCache() {
    _cachedToken = null;
    _keychainFailed = false; // allow retry after explicit clear
    try {
        if (fs.existsSync(TOKEN_CACHE_PATH)) fs.unlinkSync(TOKEN_CACHE_PATH);
    } catch { /* ignore */ }
}
