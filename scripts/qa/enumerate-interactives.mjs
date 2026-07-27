#!/usr/bin/env node
/*
 * Freezes the interactive-element inventory for one dashboard2 surface.
 *
 * The acceptance matrix scores M1 (every element behaves) and M3 (every element
 * is keyboard reachable) against a FIXED denominator. Without this, two
 * reviewers counting controls by hand would disagree on the score. The emitted
 * file is that denominator.
 *
 * Usage:
 *   node scripts/qa/enumerate-interactives.mjs --surface sidebar \
 *     --out evidence/wp2.interactives.json [--url http://127.0.0.1:24577/dashboard2/]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SURFACES, launch, resolveSurface } from './qa-lib.mjs';
import { startFixtureServer, openFixture } from './fixture-lib.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : fallback;
};

const surfaceName = flag('surface');
const outPath = flag('out');
const url = flag('url', 'http://127.0.0.1:24577/dashboard2/');
const useFixture = args.includes('--fixture');
let fixtureServer;

if (!surfaceName || !outPath) {
    console.error('Usage: enumerate-interactives.mjs --surface <name> --out <path> [--url <url>]');
    console.error(`Known surfaces: ${Object.keys(SURFACES).join(', ')}`);
    process.exit(2);
}

const surface = SURFACES[surfaceName];
if (!surface) {
    console.error(`Unknown surface "${surfaceName}". Known: ${Object.keys(SURFACES).join(', ')}`);
    process.exit(2);
}

fixtureServer = useFixture ? await startFixtureServer() : null;
const { browser, page } = useFixture ? (await openFixture(fixtureServer.url, { historyCount: 10 })) : await launch(url);
try {
    await resolveSurface(page, surface);

    const elements = await page.evaluate((rootSelector) => {
        // Kept in sync with 011_acceptance_matrix.md. Changing it changes every
        // M1/M3 denominator, so it is deliberately explicit rather than clever.
        const SELECTOR = [
            'button',
            'a[href]',
            'input',
            'select',
            'textarea',
            '[role="button"]',
            '[role="tab"]',
            '[role="menuitem"]',
            '[role="switch"]',
            '[role="separator"]',
            '[tabindex]:not([tabindex="-1"])',
        ].join(', ');

        const root = rootSelector ? document.querySelector(rootSelector) : document.body;
        if (!root) return [];

        const accessibleName = (el) => (
            el.getAttribute('aria-label')
            || el.getAttribute('title')
            || el.textContent?.trim().replace(/\s+/g, ' ').slice(0, 60)
            || el.getAttribute('placeholder')
            || `<${el.tagName.toLowerCase()}>`
        );

        const seen = new Map();
        return [...root.querySelectorAll(SELECTOR)].map((el) => {
            const base = accessibleName(el);
            const count = (seen.get(base) ?? 0) + 1;
            seen.set(base, count);
            const box = el.getBoundingClientRect();
            return {
                id: count > 1 ? `${base}#${count}` : base,
                tag: el.tagName.toLowerCase(),
                role: el.getAttribute('role'),
                disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
                visible: box.width > 0 && box.height > 0,
                inInertSubtree: Boolean(el.closest('[inert]')),
            };
        });
    }, surface.root ?? null);

    const payload = {
        surface: surfaceName,
        url,
        capturedAt: new Date().toISOString(),
        selector: 'see 011_acceptance_matrix.md §인터랙티브 요소 인벤토리 고정',
        count: elements.length,
        elements,
    };

    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`${surfaceName}: ${elements.length} interactive elements -> ${outPath}`);
} finally {
    fixtureServer?.close();
await browser.close();
}
