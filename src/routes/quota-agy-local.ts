/** Read-only adaptation of antigravity-usage 0.2.9 local/process-detector,
 * port-detective, port-prober, connect-client and local-parser.
 * Copyright (c) 2024 Antigravity Usage Contributors. MIT; see root LICENSE.
 * Bundle SHA256: 8cfe4ea7e5324aca30543f9907c57a52122a097a2da926943e4f17fe12e91fd4
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { asQuotaRecord, quotaNumber, quotaResetIso, readQuotaJson } from './quota-wire.js';

export interface AntigravityModelQuota {
    label?: string;
    modelId?: string;
    remainingPercentage?: number;
    isExhausted?: boolean;
    resetTime?: string;
    isAutocompleteOnly?: boolean;
}
export interface AntigravityQuotaSnapshot {
    method?: string;
    email?: string;
    planType?: string;
    models?: AntigravityModelQuota[];
}
export type AgyLocalReadResult = { kind: 'snapshot'; snapshot: AntigravityQuotaSnapshot; authenticated?: boolean }
    | { kind: 'unavailable'; reason: string };
type Server = { pid: number; csrf?: string; extensionPort?: number };
type RpcResult = { kind: 'ok'; data?: unknown } | { kind: 'unavailable' | 'redirect' | 'auth' };
const execFileAsync = promisify(execFile);
const RPC_ROOT = '/exa.language_server_pb.LanguageServerService/';

async function command(binary: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(binary, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 512 * 1024 });
    return stdout;
}

function port(value: unknown): number | undefined {
    const number = quotaNumber(value);
    return number !== undefined && Number.isInteger(number) && number > 0 && number <= 65535 ? number : undefined;
}

function flag(line: string, name: string): string | undefined {
    const match = line.match(new RegExp(`(?:^|\\s)--${name}(?:=|\\s+)(?:"([^"]*)"|'([^']*)'|([^\\s]+))`));
    return match?.[1] ?? match?.[2] ?? match?.[3];
}

async function discoverServer(): Promise<Server | null> {
    let candidates: Array<{ pid: unknown; line: unknown }>;
    if (process.platform === 'win32') {
        const output = await command('powershell', ['-NoProfile', '-NonInteractive', '-Command',
            'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress']);
        const parsed: unknown = JSON.parse(output);
        candidates = (Array.isArray(parsed) ? parsed : [parsed]).map(value => {
            const row = asQuotaRecord(value);
            return { pid: row?.['ProcessId'], line: row?.['CommandLine'] };
        });
    } else {
        const output = await command('ps', ['-axo', 'pid=,command=']);
        candidates = output.split('\n').map(line => {
            const match = line.match(/^\s*(\d+)\s+(.+)$/);
            return { pid: match?.[1], line: match?.[2] };
        });
    }
    const servers: Server[] = [];
    for (const { pid: rawPid, line } of candidates) {
        const pid = quotaNumber(rawPid);
        if (!pid || !Number.isSafeInteger(pid) || typeof line !== 'string') continue;
        if (!/antigravity/i.test(line) || /server installation script/i.test(line)
            || !/language[_-]server|\blsp\b|--csrf_token|--extension_server_port|exa\.language_server_pb/i.test(line)) continue;
        const csrf = flag(line, 'csrf_token');
        if (csrf !== undefined && (!csrf || /[\r\n\x00]/.test(csrf))) continue;
        const extensionPort = port(flag(line, 'extension_server_port'));
        servers.push({ pid, ...(csrf ? { csrf } : {}), ...(extensionPort ? { extensionPort } : {}) });
    }
    // A quota read cannot choose between different IDE account processes.
    return servers.length === 1 ? servers[0]! : null;
}

async function discoverPorts(server: Server): Promise<number[]> {
    let lines: string[] = [];
    const platform = process.platform;
    try {
        if (platform === 'darwin') lines = (await command('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(server.pid)])).split('\n');
        else if (platform === 'win32') lines = (await command('netstat', ['-ano'])).split('\n')
            .filter(line => /LISTENING/.test(line) && line.trim().split(/\s+/).at(-1) === String(server.pid));
        else {
            try { lines = (await command('ss', ['-tlnp'])).split('\n').filter(line => line.includes(`pid=${server.pid},`)); }
            catch { /* Older installations may only provide netstat. */ }
            if (!lines.length) lines = (await command('netstat', ['-tlnp'])).split('\n')
                .filter(line => new RegExp(`(?:^|\\s)${server.pid}/`).test(line));
        }
    } catch { /* Use only this process's explicit extension port when listing fails. */ }
    const ports: number[] = [];
    for (const line of lines) {
        const value = platform === 'darwin' ? line.match(/:(\d+)\s+\(LISTEN\)/)?.[1]
            : platform === 'win32' ? line.trim().split(/\s+/)[1]?.match(/:(\d+)$/)?.[1]
                : line.match(/:(\d+)\s/)?.[1];
        const number = port(value);
        if (number && !ports.includes(number)) ports.push(number);
        if (ports.length === 16) break;
    }
    return ports.length ? ports : server.extensionPort ? [server.extensionPort] : [];
}

function localRpc(portNumber: number, csrf: string | undefined, secure: boolean, probe: boolean): Promise<RpcResult> {
    return new Promise(resolve => {
        const timeout = probe ? 500 : 5000;
        const deadline = performance.now() + timeout;
        let settled = false;
        let incoming: http.IncomingMessage | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (result: RpcResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const req = (secure ? https : http).request({
            hostname: '127.0.0.1', port: portNumber,
            path: RPC_ROOT + (probe ? 'GetUnleashData' : 'GetUserStatus'), method: 'POST',
            ...(secure ? { rejectUnauthorized: false } : {}),
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1',
                ...(csrf ? { 'X-Codeium-Csrf-Token': csrf } : {}) },
        }, res => {
            incoming = res;
            if (settled) { res.destroy(); return; }
            const status = res.statusCode ?? 0;
            if (status >= 300 && status < 400) { finish({ kind: 'redirect' }); res.destroy(); return; }
            if (probe) {
                finish({ kind: status === 200 || status === 401 ? 'ok' : 'unavailable' });
                res.destroy();
                return;
            }
            if (status < 200 || status >= 300) {
                finish({ kind: status === 401 || status === 403 ? 'auth' : 'unavailable' });
                res.destroy();
                return;
            }
            const headers = new Headers();
            if (res.headers['content-length']) headers.set('content-length', res.headers['content-length']);
            const response = new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, { headers });
            void readQuotaJson(response, Math.max(1, deadline - performance.now())).then(
                data => finish({ kind: 'ok', data }),
                () => { finish({ kind: 'unavailable' }); res.destroy(); },
            );
        });
        req.on('error', () => finish({ kind: 'unavailable' }));
        timer = setTimeout(() => { finish({ kind: 'unavailable' }); incoming?.destroy(); req.destroy(); }, timeout);
        req.end(JSON.stringify(probe ? { wrapper_data: {} }
            : { metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' } }));
    });
}

function parseStatus(value: unknown): AgyLocalReadResult {
    const root = asQuotaRecord(value);
    const data = root && Object.hasOwn(root, 'userStatus') ? asQuotaRecord(root['userStatus']) : root;
    if (!data) return { kind: 'unavailable', reason: 'agy_local_shape_unknown' };
    const authenticated = typeof data['isAuthenticated'] === 'boolean' ? data['isAuthenticated'] : undefined;
    const configs = asQuotaRecord(data['cascadeModelConfigData'])?.['clientModelConfigs'];
    if (!Array.isArray(configs) && authenticated !== false) return { kind: 'unavailable', reason: 'agy_local_shape_unknown' };
    const models: AntigravityModelQuota[] = [];
    for (const value of Array.isArray(configs) ? configs : []) {
        const row = asQuotaRecord(value);
        if (!row) continue;
        const model = asQuotaRecord(row['modelOrAlias'])?.['model'];
        const modelId = typeof model === 'string' ? model : 'unknown';
        const label = typeof row['label'] === 'string' ? row['label'] : modelId;
        const info = asQuotaRecord(row['quotaInfo']);
        const remaining = quotaNumber(info?.['remainingFraction']);
        const resetTime = quotaResetIso(info?.['resetTime']);
        models.push({ modelId, label, ...(remaining !== undefined ? { remainingPercentage: remaining, isExhausted: remaining === 0 } : {}),
            ...(resetTime ? { resetTime } : {}), isAutocompleteOnly: /gemini-2\.5|gemini 2\.5/i.test(`${modelId} ${label}`) });
    }
    return { kind: 'snapshot', ...(authenticated !== undefined ? { authenticated } : {}),
        snapshot: { method: 'local', models, ...(typeof data['email'] === 'string' ? { email: data['email'] } : {}) } };
}

export async function readAgyLocalSnapshot(): Promise<AgyLocalReadResult> {
    try {
        const server = await discoverServer();
        if (!server) return { kind: 'unavailable', reason: 'agy_local_not_available' };
        const ports = await discoverPorts(server);
        for (const number of ports) {
            for (const secure of [true, false]) {
                const probe = await localRpc(number, server.csrf, secure, true);
                if (probe.kind === 'redirect') return { kind: 'unavailable', reason: 'agy_local_redirect_rejected' };
                if (probe.kind !== 'ok') continue;
                const status = await localRpc(number, server.csrf, secure, false);
                if (status.kind === 'redirect') return { kind: 'unavailable', reason: 'agy_local_redirect_rejected' };
                if (status.kind === 'auth') return { kind: 'snapshot', authenticated: false, snapshot: { method: 'local', models: [] } };
                return status.kind === 'ok' ? parseStatus(status.data) : { kind: 'unavailable', reason: 'agy_local_fetch_failed' };
            }
        }
    } catch { /* Process and local transport details can contain credentials. */ }
    return { kind: 'unavailable', reason: 'agy_local_not_available' };
}
