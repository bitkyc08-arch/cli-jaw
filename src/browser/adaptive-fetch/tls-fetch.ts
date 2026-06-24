import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateFetchUrl } from './safety.js';

const execFileAsync = promisify(execFile);

const PROFILES = ['chrome131', 'safari18_0', 'firefox133'] as const;
type TlsProfile = typeof PROFILES[number];

let cachedBinary: string | null | undefined;

async function detectCurlImpersonate(): Promise<string | null> {
    if (cachedBinary !== undefined) return cachedBinary;
    for (const name of ['curl-impersonate-chrome', 'curl-impersonate', 'curl_chrome131']) {
        try {
            await execFileAsync('which', [name]);
            cachedBinary = name;
            return name;
        } catch { /* not found */ }
    }
    cachedBinary = null;
    return null;
}

function selectProfile(url: string): TlsProfile {
    let hash = 0;
    const hostname = new URL(url).hostname;
    for (let i = 0; i < hostname.length; i++) hash = ((hash << 5) - hash + hostname.charCodeAt(i)) | 0;
    return PROFILES[Math.abs(hash) % PROFILES.length] ?? PROFILES[0];
}

export interface TlsFetchResult {
    ok: boolean;
    status: number;
    headers: Record<string, string>;
    body: string;
    profile: TlsProfile;
}

export async function tlsFetch(
    rawUrl: string,
    options?: { timeoutMs?: number; maxBytes?: number; proxy?: string },
): Promise<TlsFetchResult | null> {
    const binary = await detectCurlImpersonate();
    if (!binary) return null;

    const safeUrl = validateFetchUrl(rawUrl);
    const profile = selectProfile(safeUrl.href);
    const timeout = Math.ceil((options?.timeoutMs || 15_000) / 1000);

    try {
        const args = [
            '--impersonate', profile,
            '--max-time', String(timeout),
            '--max-filesize', String(options?.maxBytes || 5_000_000),
            '-L', '-s',
            '-i',
        ];
        if (options?.proxy) args.push('--proxy', options.proxy);
        args.push(safeUrl.href);
        const { stdout } = await execFileAsync(binary, args, { timeout: (timeout + 5) * 1000, maxBuffer: 10_000_000 });

        const sep = stdout.indexOf('\r\n\r\n');
        const headerText = sep > 0 ? stdout.slice(0, sep) : '';
        const body = sep > 0 ? stdout.slice(sep + 4) : stdout;
        const statusMatch = headerText.match(/HTTP\/\S+\s+(\d+)/);
        const status = statusMatch ? Number(statusMatch[1]) : 200;
        const headers: Record<string, string> = {};
        for (const line of headerText.split('\r\n').slice(1)) {
            const idx = line.indexOf(':');
            if (idx > 0) headers[line.slice(0, idx).toLowerCase().trim()] = line.slice(idx + 1).trim();
        }

        return { ok: status >= 200 && status < 400, status, headers, body, profile };
    } catch {
        return null;
    }
}

export { detectCurlImpersonate, selectProfile };
