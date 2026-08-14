/**
 * cli-jaw chat search — search chat message history
 * Usage: cli-jaw chat search <query> [--days N] [--context N] [--limit N] [--all-sessions]
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
        'all-sessions': { type: 'boolean', short: 'a' },
    },
    allowPositionals: true,
});

const query = positionals.join(' ');
if (!query) {
    console.error('Usage: cli-jaw chat search <query> [--days N] [--context N] [--limit N] [--recent N] [--all-sessions]');
    console.error('Examples:');
    console.error('  cli-jaw chat search "compact"');
    console.error('  cli-jaw chat search "compact" --days 3');
    console.error('  cli-jaw chat search "compact" --days 7 --context 2');
    console.error('  cli-jaw chat search "compact" --recent 100');
    console.error('  cli-jaw chat search "오늘" --all-sessions --days 1');
    process.exitCode = 1;
}

if (query) {
    const params = new URLSearchParams({ q: query });
    if (values.days) params.set('days', values.days);
    if (values.context) params.set('context', values.context);
    if (values.limit) params.set('limit', values.limit);
    if (values.recent) params.set('recent', values.recent);
    if (values['all-sessions']) params.set('session', '*');

    try {
        const resp = await fetch(`${SERVER}/api/messages/search?${params}`, {
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        });
        if (!resp.ok) {
            console.error(`❌ Search failed: HTTP ${resp.status}`);
            process.exitCode = 1;
        } else {
            const body = await resp.json() as Record<string, unknown>;
            const data = (Array.isArray(body) ? body : Array.isArray(body['data']) ? body['data'] : []) as Array<Record<string, unknown>>;
            if (!data.length) {
                console.log('(no matches)');
            } else {
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
            }
        }
    } catch (err) {
        console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
    }
}
