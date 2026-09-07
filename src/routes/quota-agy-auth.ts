/** Read-only adaptation of antigravity-usage 0.2.9 core/env, accounts/config,
 * accounts/storage, google/storage and google/token-manager.
 * Copyright (c) 2024 Antigravity Usage Contributors. MIT; see root LICENSE.
 * Bundle SHA256: 8cfe4ea7e5324aca30543f9907c57a52122a097a2da926943e4f17fe12e91fd4
 * Google project discovery: OpenCodex oauth/google-antigravity.ts,
 * b94051fe91e745806102988f6dff2fec8de078ef (MIT; see LICENSE).
 */
import fs from 'node:fs';
import os from 'node:os';
import { join, resolve, sep } from 'node:path';
import { asQuotaRecord, readQuotaJson } from './quota-wire.js';

export type AgyGoogleContextResult = {
    kind: 'ready'; accessToken: string; projectId?: string; email?: string;
    source: 'active-account' | 'legacy';
} | { kind: 'missing' | 'invalid' | 'expired'; reason: string };

function configDir(): string {
    const home = os.homedir();
    if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'antigravity-usage');
    if (process.platform === 'win32') return join(process.env['APPDATA'] || join(home, 'AppData', 'Roaming'), 'antigravity-usage');
    return join(process.env['XDG_CONFIG_HOME'] || join(home, '.config'), 'antigravity-usage');
}

// Read at most cap+1 bytes even if a file grows after open; never create/migrate it.
function readObject(file: string): Record<string, unknown> {
    const fd = fs.openSync(file, 'r');
    try {
        const cap = 512 * 1024;
        if (!fs.fstatSync(fd).isFile()) throw new Error('Invalid quota credential file');
        const buffer = Buffer.alloc(cap + 1);
        let bytes = 0;
        while (bytes < buffer.length) {
            const count = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null);
            if (count === 0) break;
            bytes += count;
        }
        if (bytes > cap) throw new Error('Quota credential file exceeds limit');
        const data = asQuotaRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes))));
        if (!data) throw new Error('Invalid quota credential object');
        return data;
    } finally { fs.closeSync(fd); }
}

function missingFile(error: unknown): boolean {
    return asQuotaRecord(error)?.['code'] === 'ENOENT';
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function readAgyGoogleContext(): AgyGoogleContextResult {
    const root = configDir();
    const invalid = (): AgyGoogleContextResult => ({ kind: 'invalid', reason: 'agy_auth_store_invalid' });
    let config: Record<string, unknown> = {};
    try { config = readObject(join(root, 'config.json')); }
    catch (error) { if (!missingFile(error)) return invalid(); }
    const active = text(config['activeAccount']);
    if (Object.hasOwn(config, 'activeAccount') && config['activeAccount'] !== null && !active) return invalid();
    let file = join(root, 'tokens.json');
    if (active) {
        if (active === '.' || active === '..' || /[\\/\x00-\x1f]/.test(active)) return invalid();
        const accounts = resolve(root, 'accounts');
        file = resolve(accounts, active.replace(/[^a-zA-Z0-9@._-]/g, '_'), 'tokens.json');
        if (!file.startsWith(accounts + sep)) return invalid();
    }
    let token: Record<string, unknown>;
    try { token = readObject(file); }
    catch (error) {
        return missingFile(error) ? { kind: 'missing', reason: 'agy_auth_store_missing' } : invalid();
    }
    const accessToken = text(token['accessToken']);
    const email = text(token['email']);
    if (!accessToken || (active && email && active.toLowerCase() !== email.toLowerCase())) return invalid();
    if (Object.hasOwn(token, 'expiresAt')) {
        const expiry = token['expiresAt'];
        if (typeof expiry !== 'number' || !Number.isFinite(expiry) || expiry <= 0 || !Number.isFinite(new Date(expiry).getTime())) return invalid();
        if (expiry <= Date.now()) return { kind: 'expired', reason: 'agy_token_expired' };
    }
    const projectId = text(token['projectId']);
    return {
        kind: 'ready', accessToken, source: active ? 'active-account' : 'legacy',
        ...(email ? { email } : {}), ...(projectId ? { projectId } : {}),
    };
}

export function agyQuotaUserAgent(): string {
    // Match the reference IDE wire fingerprint; it deliberately uses windows/amd64.
    return process.env['GOOGLE_ANTIGRAVITY_USER_AGENT']?.trim()
        || 'antigravity/ide/2.5.5 (os_type=windows; arch=amd64; aidev_client; auth_method=oauth)';
}

export async function loadAgyProject(accessToken: string): Promise<
    { projectId: string } | { failure: 'auth' | 'redirect' | 'unavailable' }
> {
    try {
        const response = await fetch('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', {
            method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000),
            headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json',
                'Content-Type': 'application/json', 'User-Agent': agyQuotaUserAgent() },
            body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
        });
        if (!response.ok) {
            void response.body?.cancel().catch(() => undefined);
            if (response.status >= 300 && response.status < 400) return { failure: 'redirect' };
            return { failure: response.status === 401 || response.status === 403 ? 'auth' : 'unavailable' };
        }
        const data = asQuotaRecord(await readQuotaJson(response));
        for (const key of ['cloudaicompanionProject', 'projectId', 'project']) {
            const value = data?.[key];
            const projectId = text(value) ?? text(asQuotaRecord(value)?.['id']);
            if (projectId) return { projectId };
        }
    } catch { /* A quota read never refreshes or onboards an account. */ }
    return { failure: 'unavailable' };
}
