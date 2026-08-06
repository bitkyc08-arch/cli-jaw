/**
 * cli-jaw chat search — search chat message history
 * Usage: cli-jaw chat search <query> [--days N] [--context N] [--limit N]
 */
import { parseArgs } from 'node:util';
import { getServerUrl, loadSettings } from '../../src/core/config.js';
import { getCliAuthToken, authHeaders } from '../../src/cli/api-auth.js';
import { renderLocalChatHit } from './_shared/search-format.js';

loadSettings();
const SERVER = getServerUrl();
await getCliAuthToken();

const { values, positionals } = parseArgs({
    args: process.argv.slice(4),
    options: {
        days: { type: 'string', short: 'd' },
        context: { type: 'string', short: 'c' },
        limit: { type: 'string', short: 'l' },
        recent: { type: 'string', short: 'r' },
    },
    allowPositionals: true,
});

const query = positionals.join(' ');
if (!query) {
    console.error('Usage: cli-jaw chat search <query> [--days N] [--context N] [--limit N] [--recent N]');
    console.error('Examples:');
    console.error('  cli-jaw chat search "compact"');
    console.error('  cli-jaw chat search "compact" --days 3');
    console.error('  cli-jaw chat search "compact" --days 7 --context 2');
    console.error('  cli-jaw chat search "compact" --recent 100');
    process.exit(1);
}

const params = new URLSearchParams({ q: query });
if (values.days) params.set('days', values.days);
if (values.context) params.set('context', values.context);
if (values.limit) params.set('limit', values.limit);
if (values.recent) params.set('recent', values.recent);

try {
    const resp = await fetch(`${SERVER}/api/messages/search?${params}`, {
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    });
    if (!resp.ok) {
        console.error(`❌ Search failed: HTTP ${resp.status}`);
        process.exit(1);
    }
    const body = await resp.json() as Record<string, unknown>;
    const data = (Array.isArray(body) ? body : Array.isArray(body['data']) ? body['data'] : []) as Array<Record<string, unknown>>;
    if (!data.length) {
        console.log('(no matches)');
        process.exit(0);
    }
    for (const match of data) {
        console.log(renderLocalChatHit(match));
        const ctx = match['context'] as Array<Record<string, unknown>> | undefined;
        if (ctx && Array.isArray(ctx)) {
            for (const c of ctx) {
                const prefix = c['id'] === match['id'] ? '>> ' : '   ';
                // Context lines stay tighter than the hit itself: they are there for
                // orientation, not for reading.
                console.log(`${prefix}${renderLocalChatHit(c, 200)}`);
            }
        }
        console.log('---');
    }
} catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
}
