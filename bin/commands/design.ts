/**
 * cli-jaw design — Design workspace CLI (186 Phase 4).
 *
 * FILE-FIRST: talks to src/manager/design/store.ts directly so agents can
 * list/create/read/write pages without a live dashboard. `path`/`edit`/
 * `rescan` exist to serve the direct-write workflow.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
    createDesignPage,
    exportDesignPage,
    getDesignPage,
    listDesignPages,
    listDesignPageSnapshots,
    localPathsForPage,
    readDesignPageFile,
    rescanDesignPages,
    writeDesignPageFile,
} from '../../src/manager/design/store.js';

const c = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m' };

const sub = process.argv[3];
const rest = process.argv.slice(4);

function flag(name: string): boolean {
    return rest.includes(`--${name}`);
}

function option(name: string): string | undefined {
    const index = rest.indexOf(`--${name}`);
    if (index === -1) return undefined;
    const value = rest[index + 1];
    return value && !value.startsWith('--') ? value : undefined;
}

function positional(index: number): string | undefined {
    return rest.filter(arg => !arg.startsWith('--'))[index];
}

const wantsJson = flag('json');

function emit(value: unknown, humanLines: string[]): void {
    if (wantsJson) {
        console.log(JSON.stringify(value, null, 2));
        return;
    }
    for (const line of humanLines) console.log(line);
}

function die(message: string): never {
    if (wantsJson) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`${c.red}✗${c.reset} ${message}`);
    process.exit(1);
}

function usage(): void {
    console.log(`${c.bold}cli-jaw design${c.reset} — design workspace (file-first)

  design list [--project <dir>] [--json]
  design create --title <t> [--project <dir>] [--json]
  design show <page-id> [--json]
  design path <page-id> [--json]
  design rescan [--project <dir>] [--json]
  design edit <page-id> [--editor <cmd>]
  design export <page-id> [--target <rel>] [--overwrite] [--json]
  design files <page-id> read <relpath>
  design files <page-id> write <relpath> --stdin
  design catalog list [--json]`);
}

try {
    switch (sub) {
        case 'list': {
            const pages = listDesignPages(option('project'));
            emit({ ok: true, pages }, pages.length === 0
                ? [`${c.dim}(no design pages)${c.reset}`]
                : pages.map(page => `${page.id}  ${c.bold}${page.title}${c.reset}  rev ${page.revision}${page.schemaWarning ? `  ${c.red}[schema: ${page.schemaWarning}]${c.reset}` : ''}`));
            break;
        }
        case 'create': {
            const title = option('title');
            if (!title) die('--title required');
            const page = createDesignPage({ title, projectKey: option('project') ?? null });
            emit({ ok: true, page }, [`${c.green}✓${c.reset} created ${page.id} (${page.title})`]);
            break;
        }
        case 'show': {
            const id = positional(0);
            if (!id) die('page-id required');
            const page = getDesignPage(id);
            emit({ ok: true, page }, [
                `${c.bold}${page.title}${c.reset} (${page.id})`,
                `  project: ${page.projectKey ?? '(default)'}`,
                `  revision: ${page.revision}  updated: ${page.updatedAt}`,
                `  export: ${page.exportTarget ?? '(none)'}${page.schemaWarning ? `\n  ${c.red}schema: ${page.schemaWarning}${c.reset}` : ''}`,
            ]);
            break;
        }
        case 'path': {
            const id = positional(0);
            if (!id) die('page-id required');
            const paths = localPathsForPage(id);
            emit({ ok: true, paths }, [paths.pageDir]);
            break;
        }
        case 'rescan': {
            const result = rescanDesignPages(option('project'));
            emit({ ok: true, ...result }, [`${c.green}✓${c.reset} scanned ${result.scanned} pages (${result.warnings} warnings)`]);
            break;
        }
        case 'edit': {
            const id = positional(0);
            if (!id) die('page-id required');
            const paths = localPathsForPage(id);
            const editor = option('editor') ?? process.env['VISUAL'] ?? process.env['EDITOR'] ?? 'open';
            spawn(editor, [paths.pageDir], { stdio: 'ignore', detached: true }).unref();
            emit({ ok: true, opened: paths.pageDir, editor }, [`${c.green}✓${c.reset} opened ${paths.pageDir} with ${editor}`]);
            break;
        }
        case 'export': {
            const id = positional(0);
            if (!id) die('page-id required');
            const targetOption = option('target');
            const result = targetOption !== undefined
                ? exportDesignPage(id, targetOption, { overwrite: flag('overwrite') })
                : exportDesignPage(id, undefined, { overwrite: flag('overwrite') });
            if (!result.ok) die(result.error);
            emit({ ok: true, exportedTo: result.exportedTo }, [`${c.green}✓${c.reset} exported to ${result.exportedTo}`]);
            break;
        }
        case 'files': {
            const id = positional(0);
            const action = positional(1);
            const rel = positional(2);
            if (!id || !action || !rel) die('usage: design files <page-id> read|write <relpath>');
            if (action === 'read') {
                const file = readDesignPageFile(id, rel);
                if (wantsJson) console.log(JSON.stringify({ ok: true, ...file }));
                else process.stdout.write(file.content);
                break;
            }
            if (action === 'write') {
                if (!flag('stdin')) die('write requires --stdin (pipe the content)');
                const content = readFileSync(0, 'utf-8');
                const page = getDesignPage(id);
                const result = writeDesignPageFile(id, rel, content, page.revision);
                if (!result.ok) die('conflict' in result && result.conflict ? `revision conflict (current ${result.currentRevision}); rescan and retry` : (result as { error: string }).error);
                emit({ ok: true, revision: result.revision }, [`${c.green}✓${c.reset} wrote ${rel} (rev ${result.revision})`]);
                break;
            }
            die(`unknown files action: ${action}`);
        }
        case 'snapshots': {
            const id = positional(0);
            if (!id) die('page-id required');
            const snapshots = listDesignPageSnapshots(id);
            emit({ ok: true, snapshots }, snapshots.map(s => `${s.id}  ${s.createdAt}`));
            break;
        }
        case 'catalog': {
            const entries = [{ id: 'blank-html', title: 'Blank HTML page', kind: 'html' }];
            emit({ ok: true, entries }, entries.map(entry => `${entry.id}  ${entry.title}`));
            break;
        }
        default:
            usage();
            if (sub && sub !== 'help') process.exit(1);
    }
} catch (error) {
    die((error as Error).message);
}
