/**
 * cli-jaw memory — persistent memory CLI
 */
import { parseArgs } from 'node:util';
import { getServerUrl, JAW_HOME, loadSettings } from '../../src/core/config.js';
import { getCliAuthToken, authHeaders } from '../../src/cli/api-auth.js';

loadSettings();
const SERVER = getServerUrl();
await getCliAuthToken();
const sub = process.argv[3];

async function api(method: string, path: string, body?: any) {
    const opts: Record<string, any> = { method, headers: { ...authHeaders(), 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(`${SERVER}/api/jaw-memory${path}`, opts);
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText })) as Record<string, any>;
        throw new Error(err.error || `HTTP ${resp.status}`);
    }
    return resp.json();
}

try {
    switch (sub) {
        case 'search': {
            const query = process.argv.slice(4).join(' ');
            if (!query) { console.error('Usage: cli-jaw memory search <query>'); process.exit(1); }
            const r = await api('GET', `/search?q=${encodeURIComponent(query)}`) as Record<string, any>;
            console.log(r.result);
            break;
        }
        case 'read': {
            const file = process.argv[4];
            if (!file) { console.error('Usage: cli-jaw memory read <file>'); process.exit(1); }
            const { values } = parseArgs({
                args: process.argv.slice(5),
                options: { lines: { type: 'string' } }, strict: false
            });
            const params = new URLSearchParams({ file });
            if (values.lines) params.set('lines', values.lines as string);
            const r = await api('GET', `/read?${params}`) as Record<string, any>;
            if (r.content === null) console.error(`❌ File not found: ${file}`);
            else console.log(r.content);
            break;
        }
        case 'save': {
            const file = process.argv[4];
            const content = process.argv.slice(5).join(' ');
            if (!file || !content) {
                console.error([
                    'Usage: cli-jaw memory save <file> <content>',
                    'Examples:',
                    '  cli-jaw memory save structured/profile.md "- User prefers concise Korean summaries"',
                    '  cli-jaw memory save structured/semantic/cli-jaw.md "- cli-jaw memory save requires an explicit file path"',
                    '  cli-jaw memory save structured/episodes/live/2026-04-26.md "## 10:20\\n- Completed help dialog refinement"',
                ].join('\n'));
                process.exit(1);
            }
            const r = await api('POST', '/save', { file, content }) as Record<string, any>;
            console.log(`✅ Saved to ${r.path}`);
            break;
        }
        case 'list': {
            const r = await api('GET', '/list') as Record<string, any>;
            if (r.files.length === 0) {
                console.log('(no memory files — run: cli-jaw memory init)');
            } else {
                for (const f of r.files) {
                    const kb = (f.size / 1024).toFixed(1);
                    console.log(`  ${f.path.padEnd(30)} ${kb} KB  ${f.modified.slice(0, 10)}`);
                }
            }
            break;
        }
        case 'init': {
            await api('POST', '/init', {});
            console.log(`🧠 Memory initialized at ${JAW_HOME}/memory/`);
            break;
        }
        case 'reflect': {
            const { values: reflectValues } = parseArgs({
                args: process.argv.slice(4),
                options: {
                    sinceDays: { type: 'string', default: '7' },
                    dryRun: { type: 'boolean', default: false },
                },
                strict: false,
            });
            const r = await api('POST', '/reflect', {
                sinceDays: Number(reflectValues.sinceDays) || 7,
                dryRun: reflectValues.dryRun === true,
            }) as Record<string, any>;
            console.log(JSON.stringify(r, null, 2));
            break;
        }
        case 'flush': {
            const r = await api('POST', '/flush', {}) as Record<string, any>;
            console.log(`🧠 ${r.message || 'Memory flush triggered'}`);
            break;
        }
        case 'cleanup': {
            const { values: cleanupValues } = parseArgs({
                args: process.argv.slice(4),
                options: { days: { type: 'string', default: '90' } },
                strict: false,
            });
            const r = await api('POST', '/cleanup', { retentionDays: parseInt(cleanupValues.days as string || '90') }) as Record<string, any>;
            console.log(`🧠 Archived ${(r as any).moved ?? 0} episodes`);
            break;
        }
        default:
            console.log(`
  🧠 cli-jaw memory

  Commands:
    search <query>               Search all memory files (grep)
    read <file> [--lines N-M]    Read a memory file
    save <file> <content>        Append content to a memory file
    list                         List all memory files
    init                         Initialize memory directory
    reflect [--sinceDays N]      Promote durable facts from episodes to shared pages
    flush                        Manually trigger memory flush
    cleanup [--days N]           Archive episodes older than N days (default: 90)

  Files:
    MEMORY.md          Core knowledge (auto-injected into prompt)
    preferences.md     User preferences
    decisions.md       Key decisions with dates
    people.md          People and teams
    projects/<name>.md Per-project notes
    daily/<date>.md    Auto-generated session logs
`);
    }
} catch (e) {
    console.error(`❌ ${(e as Error).message}`);
    process.exitCode = 1;
}
