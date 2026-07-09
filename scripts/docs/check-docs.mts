// Phase 2A docs drift checker: compares live AST-extracted inventories
// (commands, routes) against the summary claims in structure/*.md.
// No generated JSON is committed; this computes live and compares.
// Usage: npx tsx scripts/docs/check-docs.mts [--json]
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { extractCommands } from './extract-commands.mts';
import { extractRoutes } from './extract-routes.mts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '../..');

interface DriftIssue {
    doc: string;
    claim: string;
    actual: string;
}

function firstMatch(text: string, re: RegExp): string | null {
    const m = text.match(re);
    return m?.[1] ?? null;
}

export async function checkDocs(): Promise<DriftIssue[]> {
    const issues: DriftIssue[] = [];

    const [commands, routes, commandsDoc, serverApiDoc, indexDoc] = await Promise.all([
        extractCommands(),
        extractRoutes(),
        readFile(join(root, 'structure/commands.md'), 'utf8'),
        readFile(join(root, 'structure/server_api.md'), 'utf8'),
        readFile(join(root, 'structure/INDEX.md'), 'utf8'),
    ]);

    // commands.md summary line claims
    const docTotal = firstMatch(commandsDoc, /slash registry는 (\d+)개 커맨드/);
    if (docTotal !== null && Number(docTotal) !== commands.totals.total) {
        issues.push({ doc: 'structure/commands.md', claim: `slash registry ${docTotal}`, actual: String(commands.totals.total) });
    }
    const docNonHidden = firstMatch(commandsDoc, /non-hidden은 (\d+)개/);
    if (docNonHidden !== null && Number(docNonHidden) !== commands.totals.nonHidden) {
        issues.push({ doc: 'structure/commands.md', claim: `non-hidden ${docNonHidden}`, actual: String(commands.totals.nonHidden) });
    }
    const docCli = firstMatch(commandsDoc, /CLI (\d+) \/ Web/);
    if (docCli !== null && Number(docCli) !== commands.totals.cliVisible) {
        issues.push({ doc: 'structure/commands.md', claim: `CLI ${docCli}`, actual: String(commands.totals.cliVisible) });
    }
    const docWeb = firstMatch(commandsDoc, /Web (\d+) \/ Telegram/);
    if (docWeb !== null && Number(docWeb) !== commands.totals.webVisible) {
        issues.push({ doc: 'structure/commands.md', claim: `Web ${docWeb}`, actual: String(commands.totals.webVisible) });
    }
    const docRuntimes = firstMatch(commandsDoc, /(\d+)개다\.\s*$/m);
    if (docRuntimes !== null && Number(docRuntimes) !== commands.runtimes.count) {
        issues.push({ doc: 'structure/commands.md', claim: `runtimes ${docRuntimes}`, actual: String(commands.runtimes.count) });
    }

    // server_api.md + INDEX.md route totals
    for (const [docName, text] of [['structure/server_api.md', serverApiDoc], ['structure/INDEX.md', indexDoc]] as const) {
        for (const m of text.matchAll(/총 (\d+)개(?:의)? route handler/g)) {
            if (Number(m[1]) !== routes.core.total) {
                issues.push({ doc: docName, claim: `route handlers ${m[1]}`, actual: String(routes.core.total) });
            }
        }
        for (const m of text.matchAll(/API 엔드포인트는 (\d+)개/g)) {
            if (Number(m[1]) !== routes.core.apiTotal) {
                issues.push({ doc: docName, claim: `API endpoints ${m[1]}`, actual: String(routes.core.apiTotal) });
            }
        }
    }

    return issues;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
    const issues = await checkDocs();
    if (process.argv.includes('--json')) {
        console.log(JSON.stringify({ ok: issues.length === 0, issues }, null, 2));
    } else if (issues.length === 0) {
        console.log('docs:check PASSED — commands/routes summaries match live inventory');
    } else {
        console.error(`docs:check FAILED — ${issues.length} drift issue(s):`);
        for (const i of issues) console.error(`  - ${i.doc}: doc says "${i.claim}" vs actual ${i.actual}`);
    }
    process.exit(issues.length === 0 ? 0 : 1);
}
