#!/usr/bin/env tsx
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_DIST_DIR = 'public/dist';
const DEFAULT_ENTRY_BUDGET_BYTES = 600_000;
const FORBIDDEN_ENTRY_CHUNKS = [
    'vendor-utils',
    'vendor-mermaid',
    'mermaid',
];
const FORBIDDEN_NESTED_OUTPUT_DIRS = [
    'dist',
];

export interface BuildOutputCheckOptions {
    distDir?: string;
    entryBudgetBytes?: number;
}

export interface BuildOutputCheckResult {
    ok: boolean;
    errors: string[];
    appFiles: string[];
    eagerBytes: number;
}

function readText(path: string): string {
    return readFileSync(path, 'utf8');
}

function listAppFiles(assetsDir: string): string[] {
    if (!existsSync(assetsDir)) return [];
    return readdirSync(assetsDir)
        .filter(name => /^app-[\w-]+\.js$/.test(name))
        .map(name => join(assetsDir, name));
}

function includesForbiddenChunk(value: string): string | null {
    for (const chunk of FORBIDDEN_ENTRY_CHUNKS) {
        if (value.includes(chunk)) return chunk;
    }
    return null;
}

function checkIndexHtml(indexHtml: string, errors: string[]): void {
    const preloadRe = /<link\b[^>]*rel=["']modulepreload["'][^>]*>/gi;
    for (const match of indexHtml.matchAll(preloadRe)) {
        const offending = includesForbiddenChunk(match[0]);
        if (offending) {
            errors.push(`index.html eagerly modulepreloads ${offending}: ${match[0]}`);
        }
    }
}

function checkAppEntry(appPath: string, source: string, errors: string[]): void {
    const importRe = /\bimport\s+(?:[^'"]+\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
    for (const match of source.matchAll(importRe)) {
        const specifier = match[1] || match[2] || '';
        if (specifier.includes('mermaid-loader')) continue;
        const offending = includesForbiddenChunk(specifier);
        if (offending) {
            errors.push(`${appPath} references eager ${offending} import: ${specifier}`);
        }
    }

    const mapDepsRe = /__vite__mapDeps\(([^)]*)\)/g;
    for (const match of source.matchAll(mapDepsRe)) {
        const offending = includesForbiddenChunk(match[0]);
        if (offending) {
            errors.push(`${appPath} includes ${offending} in a Vite preload dependency list`);
        }
    }

    for (const chunk of ['vendor-utils', 'vendor-mermaid']) {
        if (source.includes(chunk)) {
            errors.push(`${appPath} contains ${chunk}; app entry must not reference it directly`);
        }
    }
}

type ManifestEntry = { src?: string; file?: string; isEntry?: boolean };

function checkHtmlEntries(distDir: string, errors: string[]): void {
    let manifest: Record<string, ManifestEntry> = {};
    try {
        const parsed: unknown = JSON.parse(readText(join(distDir, '.vite/manifest.json')));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid manifest');
        manifest = parsed as Record<string, ManifestEntry>;
    } catch {
        errors.push('Missing or invalid build manifest');
    }
    for (const entry of ['index.html', 'manager/index.html', 'settings/index.html']) {
        const htmlPath = join(distDir, entry);
        if (!existsSync(htmlPath)) { errors.push(`Missing ${htmlPath}`); continue; }
        const html = readText(htmlPath);
        checkIndexHtml(html, errors);
        const identity = manifest[entry];
        if (identity?.isEntry !== true || identity.src !== entry || typeof identity.file !== 'string' || !identity.file) {
            errors.push(`Missing entry identity: ${entry}`);
            continue;
        }
        const modules = [...html.matchAll(/<script\b(?=[^>]*type=["']module["'])[^>]*src=["']([^"']+)["'][^>]*>/gi)];
        if (modules.length !== 1) errors.push(`Expected one module entry in ${htmlPath}`);
        for (const match of modules) {
            try {
                const url = new URL(match[1]!, `http://build.invalid/dist/${entry}`);
                const relative = url.pathname.replace(/^\/dist\//, '');
                if (url.origin !== 'http://build.invalid' || !url.pathname.startsWith('/dist/assets/')
                    || relative !== identity.file || url.search || url.hash
                    || !existsSync(join(distDir, relative)) || !statSync(join(distDir, relative)).isFile()) {
                    errors.push(`Entry bundle identity mismatch: ${entry}: ${match[1]}`);
                }
            } catch {
                errors.push(`Invalid module URL: ${entry}`);
            }
        }
    }
}

export function checkWebUiBuildOutput(options: BuildOutputCheckOptions = {}): BuildOutputCheckResult {
    const distDir = options.distDir || DEFAULT_DIST_DIR;
    const entryBudgetBytes = options.entryBudgetBytes ?? DEFAULT_ENTRY_BUDGET_BYTES;
    const errors: string[] = [];
    const indexPath = join(distDir, 'index.html');
    const assetsDir = join(distDir, 'assets');

    for (const dirname of FORBIDDEN_NESTED_OUTPUT_DIRS) {
        const nestedPath = join(distDir, dirname);
        if (existsSync(nestedPath)) {
            errors.push(`Forbidden nested build output ${nestedPath}; check Vite publicDir and stale public/public artifacts`);
        }
    }
    if (!existsSync(indexPath)) errors.push(`Missing ${indexPath}`);
    if (!existsSync(assetsDir)) errors.push(`Missing ${assetsDir}`);
    if (errors.length > 0) return { ok: false, errors, appFiles: [], eagerBytes: 0 };

    checkHtmlEntries(distDir, errors);
    const appFiles = listAppFiles(assetsDir);
    if (appFiles.length === 0) errors.push(`No app-*.js files found in ${assetsDir}`);

    let eagerBytes = 0;
    for (const appPath of appFiles) {
        eagerBytes += statSync(appPath).size;
        checkAppEntry(appPath, readText(appPath), errors);
    }
    if (eagerBytes > entryBudgetBytes) {
        errors.push(`App entry bytes ${eagerBytes} exceed budget ${entryBudgetBytes}`);
    }

    return { ok: errors.length === 0, errors, appFiles, eagerBytes };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const result = checkWebUiBuildOutput();
    if (!result.ok) {
        console.error(result.errors.join('\n'));
        process.exit(1);
    }
    console.log(`Web UI build output OK (${result.appFiles.length} app entries, ${result.eagerBytes} bytes)`);
}
