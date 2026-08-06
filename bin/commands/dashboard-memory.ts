import { parseArgs } from 'node:util';
import { callDashboard as callDashboardApi, DASHBOARD_DEFAULT_PORT } from './_shared/dashboard-client.js';
import { formatFederatedResult } from './_shared/search-format.js';

const MEMORY_BASE_PATH = '/api/dashboard/memory';
const LABEL = 'dashboard memory';

async function callDashboard<T>(path: string): Promise<T> {
    return callDashboardApi<T>({ basePath: MEMORY_BASE_PATH, path, label: LABEL });
}

interface FederatedHitResponse {
    instanceId: string;
    instanceLabel: string | null;
    relpath: string;
    source_start_line: number;
    snippet?: string;
    content?: string;
}

interface SearchResponse {
    hits: FederatedHitResponse[];
    warnings: Array<{ instanceId: string; code: string; message: string }>;
    instancesQueried: number;
    instancesSucceeded: number;
}

function formatSearchResult(data: SearchResponse): string {
    return formatFederatedResult(data, hit => {
        const label = hit.instanceLabel ? ` (${hit.instanceLabel})` : '';
        return [
            `\n[${hit.instanceId}${label}] ${hit.relpath}:${hit.source_start_line}`,
            hit.snippet || (hit.content || '').slice(0, 200),
        ];
    });
}

function printHelp(): void {
    console.log(`
  jaw dashboard memory — L2 cross-instance memory search (read-only)

  Usage:
    jaw dashboard memory search "<query>" [--instance <id,id>] [--limit N]
    jaw dashboard memory read <instanceId>:<relpath>
    jaw dashboard memory instances
    jaw dashboard memory list
    jaw dashboard memory state           embedding status
    jaw dashboard memory estimate        embedding cost estimate
    jaw dashboard memory config [get|set] embedding config
    jaw dashboard memory reindex --embedding

  Options:
    --instance <ids>   comma-separated instance IDs to restrict the search
    --limit <N>        global result cap (max 200, default 50)
    --json             machine-readable JSON
    --port <port>      dashboard port (env DASHBOARD_PORT or default ${DASHBOARD_DEFAULT_PORT})

  Read-only. Companion to \`jaw memory\` (L1, instance-local r/w).
  Embedding commands manage an optional dashboard add-on; default OFF unless configured.
`);
}

export async function handleMemory(argvFromSwitch: string[]): Promise<void> {
    if (!argvFromSwitch.length || argvFromSwitch[0] === '--help' || argvFromSwitch[0] === '-h') {
        printHelp();
        return;
    }
    const sub = argvFromSwitch[0]!;
    const rest = argvFromSwitch.slice(1);
    const { values, positionals } = parseArgs({
        args: rest,
        options: {
            instance: { type: 'string' },
            limit: { type: 'string' },
            json: { type: 'boolean', default: false },
            port: { type: 'string' },
        },
        strict: false,
        allowPositionals: true,
    });
    if (values.port) process.env["DASHBOARD_PORT"] = String(values.port);

    try {
        switch (sub) {
            case 'search': {
                const q = positionals.join(' ').trim();
                if (!q) { console.error('  ❌ query required'); process.exit(1); }
                const qs = new URLSearchParams({ q });
                if (values.instance) qs.set('instance', String(values.instance));
                if (values.limit) qs.set('limit', String(values.limit));
                const result = await callDashboard<SearchResponse>(`/search?${qs.toString()}`);
                console.log(values.json ? JSON.stringify(result, null, 2) : formatSearchResult(result));
                return;
            }
            case 'instances':
            case 'list': {
                const result = await callDashboard<{
                    ok: boolean;
                    instances: Array<{ instanceId: string; label: string | null; homePath: string; homeSource: string; hasDb: boolean }>;
                }>('/instances');
                if (values.json) { console.log(JSON.stringify(result, null, 2)); return; }
                for (const i of result.instances) {
                    console.log(`[${i.instanceId}] ${i.label || '(no label)'} — ${i.homePath} (${i.homeSource}) ${i.hasDb ? '✓' : '✗ no db'}`);
                }
                return;
            }
            case 'read': {
                const arg = positionals[0] || '';
                const sep = arg.indexOf(':');
                if (sep < 0) { console.error('  ❌ expected <instanceId>:<relpath>'); process.exit(1); }
                const instance = arg.slice(0, sep);
                const path = arg.slice(sep + 1);
                const result = await callDashboard<{ ok: boolean; content: string; path: string }>(
                    `/read?instance=${encodeURIComponent(instance)}&path=${encodeURIComponent(path)}`
                );
                console.log(values.json ? JSON.stringify(result, null, 2) : result.content);
                return;
            }
            case 'config':
                await handleEmbedConfig(positionals);
                return;
            case 'state':
            case 'embed-state': {
                const body = await callDashboard<{ ok: boolean; status: Record<string, unknown> }>('/embed-state');
                const data = body.status || {};
                if (values.json) { console.log(JSON.stringify(data, null, 2)); return; }
                console.log(`State: ${data['state'] || 'OFF'}  Mode: ${data['mode'] || '-'}`);
                console.log(`Provider: ${data['provider'] || '-'}/${data['model'] || '-'}`);
                console.log(`Chunks: ${data['indexedChunks'] || 0}  DB: ${Number(data['dbSizeBytes'] || 0) > 0 ? ((Number(data['dbSizeBytes'])) / 1024 / 1024).toFixed(1) + ' MB' : '-'}`);
                console.log(`Last sync: ${data['lastSyncAt'] || 'never'}`);
                return;
            }
            case 'estimate':
            case 'embed-estimate': {
                const data = await callDashboard<Record<string, unknown>>('/embed-estimate');
                if (values.json) { console.log(JSON.stringify(data, null, 2)); return; }
                console.log(`Chunks: ${data['totalChunks']}  Batches: ${data['batches']}  ~${Math.ceil(Number(data['estimatedSeconds']))}s  $${Number(data['estimatedCost'] || 0).toFixed(4)}`);
                return;
            }
            case 'reindex':
                await handleReindex(rest);
                return;
            default:
                console.error(`  ❌ unknown subcommand: ${sub}`);
                printHelp();
                process.exit(1);
        }
    } catch (err) {
        console.error(`  ❌ ${(err as Error).message}`);
        process.exit(1);
    }
}

async function postDashboard<T>(path: string, body: unknown): Promise<T> {
    return callDashboardApi<T>({ basePath: MEMORY_BASE_PATH, path, label: LABEL, body });
}

async function handleEmbedConfig(args: string[]): Promise<void> {
    const sub = args[0];

    if (!sub || sub === 'get') {
        const data = await callDashboard<{ ok: boolean; config: unknown }>('/embed-config');
        console.log(JSON.stringify(data, null, 2));
        return;
    }

    if (sub === 'set') {
        const config: Record<string, unknown> = {};
        for (let i = 1; i < args.length; i++) {
            switch (args[i]) {
                case '--provider': config['provider'] = args[++i]; break;
                case '--model': config['model'] = args[++i]; break;
                case '--api-key': config['apiKey'] = args[++i]; break;
                case '--dimensions': config['dimensions'] = Number(args[++i]); break;
                case '--mode': config['searchMode'] = args[++i]; break;
                case '--enabled': config['enabled'] = true; break;
                case '--disabled': config['enabled'] = false; break;
            }
        }
        const data = await postDashboard<{ ok: boolean; saved: boolean; needsReindex: boolean }>('/embed-config', config);
        console.log(JSON.stringify(data, null, 2));
        return;
    }

    console.error('Usage: cli-jaw dashboard memory config [get|set] [--provider ...] [--api-key ...] [--mode ...]');
    process.exit(1);
}

async function handleReindex(args: string[]): Promise<void> {
    const hasEmbedding = args.includes('--embedding');
    if (!hasEmbedding) {
        console.error('Usage: cli-jaw dashboard memory reindex --embedding');
        process.exit(1);
    }
    console.log('Starting embedding sync...');
    const data = await postDashboard<{
        ok: boolean;
        results?: Array<{ instanceId: string; added: number; updated: number; deleted: number; skipped: number; errors: string[] }>;
        error?: string;
        code?: string;
    }>('/reindex', {});
    if (data.ok && data.results) {
        for (const r of data.results) {
            console.log(`  ${r.instanceId}: +${r.added} updated=${r.updated} deleted=${r.deleted} skipped=${r.skipped}${r.errors.length ? ' errors=' + r.errors.length : ''}`);
        }
    } else {
        console.error('Reindex failed:', data.error || data.code);
        process.exit(1);
    }
}
