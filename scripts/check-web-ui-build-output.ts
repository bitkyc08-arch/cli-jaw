#!/usr/bin/env tsx
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const DEFAULT_DIST_DIR = 'public/dist';
const DEFAULT_ENTRY_BUDGET_BYTES = 600_000;
const SHIKI_AGGREGATE_GZIP_BUDGET = 450 * 1024;
const SHIKI_SINGLE_GZIP_BUDGET = 300 * 1024;
const DASHBOARD2_ENTRY_KEY = 'dashboard2/index.html';
const HIGHLIGHT_SERVICE_SOURCE = 'public/dashboard2/src/turn-stream/render/highlight-service.ts';
// Every Vite entry must ship its HTML shell; assets/<entry>-*.js must exist
// for each named entry (existence-only — perf budgets stay app-scoped).
const REQUIRED_ENTRY_HTML = [
    'index.html',
    'manager/index.html',
    'dashboard2/index.html',
];
const REQUIRED_ENTRY_JS_PREFIXES = [
    'app',
    'manager',
    'dashboard2',
];
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
    dashboard2Bundle: Dashboard2BundleReport | null;
}

export interface ManifestNode {
    file: string;
    imports?: string[];
    dynamicImports?: string[];
}

export interface Dashboard2BundleReport {
    entryKey: string;
    staticShikiCount: number;
    lazyFiles: string[];
    rawBytes: number;
    gzipBytes: number;
    largestChunk: { file: string; rawBytes: number; gzipBytes: number } | null;
    workerFile: string | null;
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

function hasEntryJs(assetsDir: string, prefix: string): boolean {
    if (!existsSync(assetsDir)) return false;
    const entryRe = new RegExp(`^${prefix}-[\\w-]+\\.js$`);
    return readdirSync(assetsDir).some(name => entryRe.test(name));
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

function collectGraph(manifest: Record<string, ManifestNode>, roots: Iterable<string>, includeDynamic: boolean): Set<string> {
    const seen = new Set<string>();
    const visit = (key: string): void => {
        if (seen.has(key)) return;
        seen.add(key);
        const node = manifest[key];
        if (!node) return;
        for (const imported of node.imports ?? []) visit(imported);
        if (includeDynamic) for (const imported of node.dynamicImports ?? []) visit(imported);
    };
    for (const root of roots) visit(root);
    return seen;
}

function isShiki(value: string): boolean {
    return /(?:@shikijs|(?:^|[/_-])shiki(?:[/_.-]|$)|render-shiki)/i.test(value);
}

function isKatex(value: string): boolean {
    return /(?:(?:^|[/_-])katex(?:[/_.-]|$)|render-katex)/i.test(value);
}

function isMermaid(value: string): boolean {
    return /(?:^|[/_.-])mermaid(?:[/_.-]|$)/i.test(value);
}

export function isJwcChunk(value: string): boolean {
    return /(?:^|[/_.-])(?:jwc|jawcode)(?:[/_.-]|$)/i.test(value);
}

export function isCodeChunk(value: string): boolean {
    return /(?:^|[/_.-])code(?:[/_.-]|$)/i.test(value);
}

export function isJwcOrCodeChunk(value: string): boolean {
    return isJwcChunk(value) || isCodeChunk(value);
}

export function dashboard2StaticClosureHasJwcOrCodeChunk(
    manifest: Record<string, ManifestNode>,
): boolean {
    const staticGraph = collectGraph(manifest, [DASHBOARD2_ENTRY_KEY], false);
    return [...staticGraph].some(key => {
        const node = manifest[key];
        return isJwcOrCodeChunk(key) || isJwcOrCodeChunk(node?.file ?? '');
    });
}

function findWorkerFile(distDir: string, serviceFiles: string[]): string | null {
    const assetsDir = join(distDir, 'assets');
    if (!existsSync(assetsDir)) return null;
    const emitted = readdirSync(assetsDir).find(name => /^highlight-worker-[\w-]+\.js$/.test(name));
    if (emitted) return `assets/${emitted}`;
    for (const serviceFile of serviceFiles) {
        const source = readText(join(distDir, serviceFile));
        const match = source.match(/["'`](?:\.\/)?(assets\/)?(highlight-worker-[\w-]+\.js)["'`]/);
        if (match) return `assets/${match[2]}`;
    }
    return null;
}

function checkDashboard2Bundle(distDir: string, errors: string[]): Dashboard2BundleReport | null {
    const manifestPath = join(distDir, '.vite', 'manifest.json');
    if (!existsSync(manifestPath)) {
        errors.push(`Missing ${manifestPath}`);
        return null;
    }
    const manifest = JSON.parse(readText(manifestPath)) as Record<string, ManifestNode>;
    const entry = manifest[DASHBOARD2_ENTRY_KEY];
    if (!entry) {
        errors.push(`Missing ${DASHBOARD2_ENTRY_KEY} in ${manifestPath}`);
        return null;
    }
    const staticGraph = collectGraph(manifest, [DASHBOARD2_ENTRY_KEY], false);
    const staticShiki = [...staticGraph].filter(key => {
        const node = manifest[key];
        return isShiki(key) || isShiki(node?.file ?? '');
    });
    const staticKatex = [...staticGraph].filter(key => {
        const node = manifest[key];
        return isKatex(key) || isKatex(node?.file ?? '');
    });
    const staticMermaid = [...staticGraph].filter(key => {
        const node = manifest[key];
        return isMermaid(key) || isMermaid(node?.file ?? '');
    });
    const staticJwcOrCode = [...staticGraph].filter(key => {
        const node = manifest[key];
        return isJwcOrCodeChunk(key) || isJwcOrCodeChunk(node?.file ?? '');
    });
    if (staticShiki.length > 0) errors.push(`Dashboard2 static import closure contains Shiki: ${staticShiki.join(', ')}`);
    if (staticKatex.length > 0) errors.push(`Dashboard2 static import closure contains KaTeX: ${staticKatex.join(', ')}`);
    if (staticMermaid.length > 0) errors.push(`Dashboard2 static import closure contains Mermaid: ${staticMermaid.join(', ')}`);
    if (staticJwcOrCode.length > 0) errors.push(`Dashboard2 static import closure contains JWC/Code chunks: ${staticJwcOrCode.join(', ')}`);

    const serviceKeys = Object.keys(manifest).filter(key => {
        if (/turn-stream\/render\/highlight-service\.ts$/.test(key)) return true;
        if ((manifest[key]?.dynamicImports ?? []).some(imported => isShiki(imported) || isShiki(manifest[imported]?.file ?? ''))) return true;
        const file = manifest[key]?.file;
        if (!file || !file.endsWith('.js') || !existsSync(join(distDir, file))) return false;
        return /highlight-worker-[\w-]+\.js/.test(readText(join(distDir, file)));
    });
    const serviceExpected = serviceKeys.length > 0 || (distDir === DEFAULT_DIST_DIR && existsSync(HIGHLIGHT_SERVICE_SOURCE));
    const serviceFiles = serviceKeys.map(key => manifest[key]?.file).filter((file): file is string => Boolean(file));
    const dynamicRoots = serviceKeys
        .flatMap(key => manifest[key]?.dynamicImports ?? [])
        .filter(key => isShiki(key) || isShiki(manifest[key]?.file ?? ''));
    const lazyGraph = collectGraph(manifest, dynamicRoots, true);
    const lazyFiles = [...new Set([...lazyGraph]
        .map(key => manifest[key]?.file)
        .filter((file): file is string => typeof file === 'string' && file.endsWith('.js')))]
        .sort();
    if (serviceExpected && lazyFiles.every(file => !/shiki/i.test(file))) {
        errors.push('Highlight service exists but no render-shiki lazy chunk was found');
    }
    const workerFile = serviceExpected ? findWorkerFile(distDir, serviceFiles) : null;
    if (serviceExpected && !workerFile) errors.push('Highlight service exists but emitted highlight worker file was not found');
    const measuredFiles = [...new Set([...lazyFiles, ...(workerFile ? [workerFile] : [])])];
    const chunks = measuredFiles.filter(file => existsSync(join(distDir, file))).map(file => {
        const bytes = readFileSync(join(distDir, file));
        return { file, rawBytes: bytes.byteLength, gzipBytes: gzipSync(bytes, { level: 9 }).byteLength };
    });
    const rawBytes = chunks.reduce((sum, chunk) => sum + chunk.rawBytes, 0);
    const gzipBytes = chunks.reduce((sum, chunk) => sum + chunk.gzipBytes, 0);
    const largestChunk = chunks.reduce<Dashboard2BundleReport['largestChunk']>(
        (largest, chunk) => !largest || chunk.gzipBytes > largest.gzipBytes ? chunk : largest,
        null,
    );
    if (gzipBytes > SHIKI_AGGREGATE_GZIP_BUDGET) errors.push(`Shiki lazy aggregate gzip ${gzipBytes} exceeds ${SHIKI_AGGREGATE_GZIP_BUDGET}`);
    for (const chunk of chunks) {
        if (chunk.gzipBytes > SHIKI_SINGLE_GZIP_BUDGET) errors.push(`Shiki lazy chunk ${chunk.file} gzip ${chunk.gzipBytes} exceeds ${SHIKI_SINGLE_GZIP_BUDGET}`);
    }
    return { entryKey: DASHBOARD2_ENTRY_KEY, staticShikiCount: staticShiki.length, lazyFiles: measuredFiles, rawBytes, gzipBytes, largestChunk, workerFile };
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
    for (const relHtml of REQUIRED_ENTRY_HTML) {
        const htmlPath = join(distDir, relHtml);
        if (!existsSync(htmlPath)) errors.push(`Missing ${htmlPath}`);
    }
    if (!existsSync(assetsDir)) errors.push(`Missing ${assetsDir}`);
    if (errors.length > 0) return { ok: false, errors, appFiles: [], eagerBytes: 0, dashboard2Bundle: null };

    checkIndexHtml(readText(indexPath), errors);
    const appFiles = listAppFiles(assetsDir);
    if (appFiles.length === 0) errors.push(`No app-*.js files found in ${assetsDir}`);
    for (const prefix of REQUIRED_ENTRY_JS_PREFIXES) {
        if (prefix === 'app') continue; // covered by listAppFiles above
        if (!hasEntryJs(assetsDir, prefix)) {
            errors.push(`No ${prefix}-*.js entry found in ${assetsDir}`);
        }
    }

    let eagerBytes = 0;
    for (const appPath of appFiles) {
        eagerBytes += statSync(appPath).size;
        checkAppEntry(appPath, readText(appPath), errors);
    }
    if (eagerBytes > entryBudgetBytes) {
        errors.push(`App entry bytes ${eagerBytes} exceed budget ${entryBudgetBytes}`);
    }

    const dashboard2Bundle = checkDashboard2Bundle(distDir, errors);
    return { ok: errors.length === 0, errors, appFiles, eagerBytes, dashboard2Bundle };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const result = checkWebUiBuildOutput();
    if (!result.ok) {
        if (result.dashboard2Bundle) console.error(JSON.stringify(result.dashboard2Bundle));
        console.error(result.errors.join('\n'));
        process.exit(1);
    }
    console.log(JSON.stringify(result.dashboard2Bundle));
    const bundle = result.dashboard2Bundle;
    if (bundle) console.log(`Dashboard2 bundle OK (entry=${bundle.entryKey}, static-shiki=${bundle.staticShikiCount}, lazy=${bundle.lazyFiles.join(',') || 'none'}, raw=${bundle.rawBytes}, gzip=${bundle.gzipBytes}, largest=${bundle.largestChunk?.file ?? 'none'}:${bundle.largestChunk?.gzipBytes ?? 0})`);
    console.log(`Web UI build output OK (${result.appFiles.length} app entries, ${result.eagerBytes} bytes)`);
}
