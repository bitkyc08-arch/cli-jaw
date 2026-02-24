/**
 * cli-claw memory — persistent memory CLI
 */
import { parseArgs } from 'node:util';
import { getServerUrl } from '../../src/core/config.js';

const SERVER = getServerUrl();
const sub = process.argv[3];

async function api(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(`${SERVER}/api/claw-memory${path}`, opts);
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        throw new Error(err.error || `HTTP ${resp.status}`);
    }
    return resp.json();
}

try {
    switch (sub) {
        case 'search': {
            const query = process.argv.slice(4).join(' ');
            if (!query) { console.error('Usage: cli-claw memory search <query>'); process.exit(1); }
            const r = await api('GET', `/search?q=${encodeURIComponent(query)}`);
            console.log(r.result);
            break;
        }
        case 'read': {
            const file = process.argv[4];
            if (!file) { console.error('Usage: cli-claw memory read <file>'); process.exit(1); }
            const { values } = parseArgs({
                args: process.argv.slice(5),
                options: { lines: { type: 'string' } }, strict: false
            });
            const params = new URLSearchParams({ file });
            if (values.lines) params.set('lines', values.lines);
            const r = await api('GET', `/read?${params}`);
            if (r.content === null) console.error(`❌ File not found: ${file}`);
            else console.log(r.content);
            break;
        }
        case 'save': {
            const file = process.argv[4];
            const content = process.argv.slice(5).join(' ');
            if (!file || !content) { console.error('Usage: cli-claw memory save <file> <content>'); process.exit(1); }
            const r = await api('POST', '/save', { file, content });
            console.log(`✅ Saved to ${r.path}`);
            break;
        }
        case 'list': {
            const r = await api('GET', '/list');
            if (r.files.length === 0) {
                console.log('(no memory files — run: cli-claw memory init)');
            } else {
                for (const f of r.files) {
                    const kb = (f.size / 1024).toFixed(1);
                    console.log(`  ${f.path.padEnd(30)} ${kb} KB  ${f.modified.slice(0, 10)}`);
                }
            }
            break;
        }
        case 'init': {
            await api('POST', '/init');
            console.log('🧠 Memory initialized at ~/.cli-claw/memory/');
            break;
        }
        default:
            console.log(`
  🧠 cli-claw memory

  Commands:
    search <query>               Search all memory files (grep)
    read <file> [--lines N-M]    Read a memory file
    save <file> <content>        Append content to a memory file
    list                         List all memory files
    init                         Initialize memory directory

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
    console.error(`❌ ${e.message}`);
    process.exitCode = 1;
}
