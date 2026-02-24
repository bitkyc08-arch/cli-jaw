// ─── Copilot Quota: copilot_internal/user API via keychain ──────
// Token source: macOS keychain service "copilot-cli"
// Cached in memory to avoid repeated keychain popups.

import { execSync } from 'child_process';

let _cachedToken = null;

function getCopilotToken() {
    if (_cachedToken) return _cachedToken;
    try {
        _cachedToken = execSync(
            'security find-generic-password -s "copilot-cli" -w',
            { encoding: 'utf8', timeout: 5000 }
        ).trim();
    } catch (e) {
        console.warn('[quota-copilot] keychain read failed:', e.message?.split('\n')[0]);
        return null;
    }
    return _cachedToken || null;
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
        if (!res.ok) return null;
        const data = await res.json();

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
    } catch (e) {
        console.error('[quota-copilot]', e.message);
        return null;
    }
}

/** Clear cached token (e.g. after re-login) */
export function clearCopilotTokenCache() {
    _cachedToken = null;
}
