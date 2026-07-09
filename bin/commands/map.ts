import { parseArgs } from 'node:util';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { shouldShowHelp, printAndExit } from '../helpers/help.js';
import { buildRepoMap, renderRepoMap } from '../../src/workflows/repo-map/index.js';

if (shouldShowHelp(process.argv)) printAndExit(`
  jaw map — print a ranked structure map

  Usage: jaw map <path> [--budget <tokens>]

  Arguments:
    <path>          File or directory to scan (default: .)

  Options:
    --budget <N>    Approximate token budget (default: 4096)

  Exit codes:
    0  Map printed
    1  Path unreadable or invalid
`);

const { values, positionals } = parseArgs({
    args: process.argv.slice(3),
    options: {
        budget: { type: 'string', default: '4096' },
    },
    allowPositionals: true,
    strict: false,
});

const targetPath = resolve(positionals[0] ?? '.');
const budget = Number.parseInt(String(values.budget), 10);

if (!Number.isFinite(budget) || budget <= 0) {
    console.error('cli-jaw map: --budget must be a positive integer.');
    process.exit(1);
}

try {
    if (!existsSync(targetPath)) {
        console.error(`cli-jaw map: cannot read ${targetPath}. Check the path and try again.`);
        process.exit(1);
    }
    const stat = statSync(targetPath);
    if (!stat.isDirectory() && !stat.isFile()) {
        console.error(`cli-jaw map: cannot read ${targetPath}. Expected a file or directory.`);
        process.exit(1);
    }

    const repoMap = buildRepoMap(targetPath, { budgetTokens: budget });
    console.log(renderRepoMap(repoMap));
} catch {
    console.error(`cli-jaw map: cannot read ${targetPath}. Check permissions and try again.`);
    process.exit(1);
}
