// ─── Copilot Quota: copilot_internal/user API ───────────────────
// Token resolution order:
//   1. ENV vars (COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN)
//   2. File cache (~/.cli-jaw/auth/copilot-token) — no keychain popup
//   3. `gh auth token` — cross-platform fallback
//   4. macOS Keychain (one-shot, cached to file, suppress on failure)
//
// Source: https://docs.github.com/copilot — official credential order

import { execFileSync } from 'child_process';
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

// ─── Copilot config reader ──────────────────────────
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

// ─── File cache with account binding ────────────────
function writeTokenCache(login: string, token: string) {
    try {
        fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
        fs.writeFileSync(TOKEN_CACHE_PATH, `${login}\n${token}`, { mode: 0o600 });
    } catch (e: unknown) {
        console.warn('[quota-copilot] token cache write failed:', (e as Error).message);
    }
}

function readTokenCache(expectedLogin: string | null): string | null {
    try {
        if (!fs.existsSync(TOKEN_CACHE_PATH)) return null;
        const content = fs.readFileSync(TOKEN_CACHE_PATH, 'utf8').trim();
        const newlineIdx = content.indexOf('\n');
        if (newlineIdx < 0) return null; // old format or corrupt

        const cachedLogin = content.slice(0, newlineIdx);
        const cachedToken = content.slice(newlineIdx + 1).trim();

        // Account binding: invalidate if login changed
        if (expectedLogin && cachedLogin !== expectedLogin) {
            console.info(`[quota-copilot] cache login mismatch (${cachedLogin} ≠ ${expectedLogin}), invalidating`);
            try { fs.unlinkSync(TOKEN_CACHE_PATH); } catch { /* ignore */ }
            return null;
        }

        return cachedToken || null;
    } catch { return null; }
}

// ─── Token resolver ─────────────────────────────────
function getCopilotToken() {
    if (_cachedToken) return _cachedToken;

    const copilotUser = readCopilotConfig();
    const expectedLogin = copilotUser?.login || null;

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
    const cached = readTokenCache(expectedLogin);
    if (cached) {
        _cachedToken = cached;
        return _cachedToken;
    }

    // ─── 3. `gh auth token` fallback (cross-platform) ───
    try {
        const ghToken = execFileSync('gh', ['auth', 'token'], {
            encoding: 'utf8',
            timeout: 5000,
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        if (ghToken) {
            _cachedToken = ghToken;
            writeTokenCache(expectedLogin || 'gh-cli', ghToken);
            return _cachedToken;
        }
    } catch {
        // gh CLI not installed or not authenticated — continue
    }

    // ─── 4. macOS Keychain (one-shot, then cache to file) ───
    if (process.platform === 'darwin' && !_keychainFailed) {
        try {
            const args = ['find-generic-password', '-s', 'copilot-cli'];
            if (copilotUser) {
                args.push('-a', `${copilotUser.host}:${copilotUser.login}`);
            }
            args.push('-w');

            const token = execFileSync('security', args, {
                encoding: 'utf8',
                timeout: 5000,
                stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();

            if (token) {
                _cachedToken = token;
                writeTokenCache(expectedLogin || 'keychain', token);
                return _cachedToken;
            }
        } catch (e: unknown) {
            console.warn('[quota-copilot] keychain read failed (suppressed until restart):', (e as Error).message?.split('\n')[0]);
            _keychainFailed = true;
            return null;
        }
    }

    // win32/linux: no keychain CLI — rely on env/gh/cache above
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
