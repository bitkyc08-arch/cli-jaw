#!/usr/bin/env node
/*
 * E1 gate: zero serious/critical axe violations on a surface.
 *
 * synara has strong a11y patterns but no automated gate. This is one of the
 * places the "150%" bar means turning their convention into an executable
 * check. axe-core is already a dependency, so nothing new is installed.
 *
 * Usage:
 *   node scripts/qa/axe-scan.mjs --surface sidebar --out evidence/wp2.axe.json
 *   node scripts/qa/axe-scan.mjs --all --out evidence/all.axe.json
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { SURFACES, launch, resolveSurface } from './qa-lib.mjs';
import { startFixtureServer, openFixture } from './fixture-lib.mjs';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const outPath = flag('out');
const url = flag('url', 'http://127.0.0.1:24577/dashboard2/');
const useFixture = args.includes('--fixture');
let fixtureServer;
const targets = has('all') ? Object.keys(SURFACES) : [flag('surface')].filter(Boolean);

if (!outPath || targets.length === 0) {
    console.error('Usage: axe-scan.mjs (--surface <name> | --all) --out <path> [--url <url>]');
    console.error(`Known surfaces: ${Object.keys(SURFACES).join(', ')}`);
    process.exit(2);
}

const axeSource = await readFile(require.resolve('axe-core/axe.min.js'), 'utf8');
const results = [];

fixtureServer = useFixture ? await startFixtureServer() : null;

for (const name of targets) {
    const surface = SURFACES[name];
    if (!surface) {
        console.error(`Unknown surface "${name}"`);
        process.exit(2);
    }

    const { browser, page } = useFixture ? (await openFixture(fixtureServer.url, { historyCount: 10 })) : await launch(url);
    try {
        await resolveSurface(page, surface);
        await page.addScriptTag({ content: axeSource });

        const violations = await page.evaluate(async (rootSelector) => {
            const context = rootSelector && document.querySelector(rootSelector) ? rootSelector : document;
            const report = await globalThis.axe.run(context, { resultTypes: ['violations'] });
            return report.violations.map((violation) => ({
                id: violation.id,
                impact: violation.impact,
                help: violation.help,
                nodes: violation.nodes.length,
                targets: violation.nodes.slice(0, 5).map((node) => node.target.join(' ')),
            }));
        }, surface.root ?? null);

        const blocking = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
        results.push({ surface: name, owner: surface.owner, violations, blockingCount: blocking.length });
        console.log(`${name}: ${violations.length} violations, ${blocking.length} serious/critical`);
    } catch (error) {
        results.push({ surface: name, owner: surface.owner, error: String(error?.message ?? error), blockingCount: null });
        console.error(`${name}: scan failed — ${error?.message ?? error}`);
    } finally {
        await browser.close();
    }
}

fixtureServer?.close();

const scanned = results.filter((entry) => entry.blockingCount !== null);
const totalBlocking = scanned.reduce((sum, entry) => sum + entry.blockingCount, 0);
const failed = results.length - scanned.length;
const payload = {
    capturedAt: new Date().toISOString(),
    url,
    threshold: 'serious + critical == 0',
    verdict: failed === 0 && totalBlocking === 0 ? 'pass' : 'fail',
    totalBlocking,
    scanErrors: failed,
    results,
};

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`E1 ${payload.verdict}: ${totalBlocking} serious/critical, ${failed} scan errors -> ${outPath}`);
process.exit(payload.verdict === 'pass' ? 0 : 1);
