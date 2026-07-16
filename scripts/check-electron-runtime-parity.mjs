#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
    lstatSync,
    readFileSync,
    readdirSync,
    readlinkSync,
    statSync,
} from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';

const DEFAULT_APP_RELATIVE_PATH = 'electron/dist/mac-arm64/cli-jaw.app';
const SCANNABLE_EXTENSIONS = new Set(['.cjs', '.html', '.js', '.mjs']);

const GLOBAL_RETIRED_MARKERS = [
    { name: 'pullAndPost', pattern: /\bpullAndPost\b/, sample: 'pullAndPost' },
    { name: 'setupMetricsBridge', pattern: /\bsetupMetricsBridge\b/, sample: 'setupMetricsBridge' },
    { name: 'cli-jaw:metrics:get-latest', pattern: /cli-jaw:metrics:get-latest/, sample: 'cli-jaw:metrics:get-latest' },
    { name: './metrics.js preload import', pattern: /["']\.\/metrics\.js["']/, sample: "'./metrics.js'" },
];

const PRELOAD_MARKERS = [
    { name: 'metrics route', pattern: /\/api\/dashboard\/electron-metrics/, sample: '/api/dashboard/electron-metrics' },
    { name: 'Electron identity header', pattern: /X-CLI-Jaw-Electron/i, sample: 'X-CLI-Jaw-Electron' },
    { name: 'getMetrics', pattern: /\bgetMetrics\b/, sample: 'getMetrics' },
    { name: 'getLatestMetrics', pattern: /\bgetLatestMetrics\b/, sample: 'getLatestMetrics' },
    { name: 'installDesktopFetchHeader', pattern: /\binstallDesktopFetchHeader\b/, sample: 'installDesktopFetchHeader' },
    { name: 'renderer token', pattern: /CLI_JAW_ELECTRON_RENDERER_TOKEN/, sample: 'CLI_JAW_ELECTRON_RENDERER_TOKEN' },
];

const PAGE_WORLD_MARKERS = [
    { name: 'Electron identity header', pattern: /X-CLI-Jaw-Electron/i, sample: 'X-CLI-Jaw-Electron' },
    { name: 'renderer token', pattern: /CLI_JAW_ELECTRON_RENDERER_TOKEN/, sample: 'CLI_JAW_ELECTRON_RENDERER_TOKEN' },
    { name: 'installDesktopFetchHeader', pattern: /\binstallDesktopFetchHeader\b/, sample: 'installDesktopFetchHeader' },
];

class ArtifactParityError extends Error {
    constructor(issues) {
        const visibleIssues = issues.slice(0, 50);
        const remainder = issues.length - visibleIssues.length;
        const detail = visibleIssues.map((issue) => `  - ${issue}`).join('\n');
        super(`[electron-runtime-parity] FAILED (${issues.length} issue${issues.length === 1 ? '' : 's'})\n${detail}${remainder > 0 ? `\n  - ... ${remainder} more issue(s)` : ''}`);
        this.name = 'ArtifactParityError';
        this.issues = issues;
    }
}

function sha256(content) {
    return createHash('sha256').update(content).digest('hex');
}

function toPosix(path) {
    return path.split(sep).join('/');
}

function globToRegExp(glob) {
    let source = '^';
    for (let index = 0; index < glob.length; index += 1) {
        const char = glob[index];
        if (char === '*' && glob[index + 1] === '*') {
            index += 1;
            if (glob[index + 1] === '/') {
                index += 1;
                source += '(?:.*/)?';
            } else {
                source += '.*';
            }
        } else if (char === '*') {
            source += '[^/]*';
        } else if (char === '?') {
            source += '[^/]';
        } else {
            source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
        }
    }
    return new RegExp(`${source}$`);
}

function compileExclusions(patterns) {
    return patterns.map((pattern) => ({ pattern, regexp: globToRegExp(pattern) }));
}

function isExcluded(relativePath, compiledExclusions) {
    const parts = relativePath.split('/');
    for (let length = 1; length <= parts.length; length += 1) {
        const candidate = parts.slice(0, length).join('/');
        if (compiledExclusions.some(({ regexp }) => regexp.test(candidate))) return true;
    }
    return false;
}

function requireDirectory(path, label) {
    try {
        if (statSync(path).isDirectory()) return;
    } catch { /* reported below */ }
    throw new Error(`${label} directory missing: ${path}`);
}

function requireFile(path, label) {
    try {
        if (statSync(path).isFile()) return;
    } catch { /* reported below */ }
    throw new Error(`${label} file missing: ${path}`);
}

function createTreeManifest(root, options = {}) {
    const label = options.label ?? 'artifact';
    requireDirectory(root, label);
    const exclusions = compileExclusions(options.excludePatterns ?? []);
    const manifest = [];

    function walk(directory) {
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const absolutePath = join(directory, entry.name);
            const relativePath = toPosix(relative(root, absolutePath));
            if (isExcluded(relativePath, exclusions)) continue;
            const stat = lstatSync(absolutePath);
            if (stat.isDirectory()) {
                walk(absolutePath);
            } else if (stat.isFile()) {
                const content = readFileSync(absolutePath);
                manifest.push({ path: relativePath, type: 'file', size: content.length, sha256: sha256(content) });
            } else if (stat.isSymbolicLink()) {
                const target = readlinkSync(absolutePath);
                manifest.push({ path: relativePath, type: 'symlink', size: Buffer.byteLength(target), sha256: sha256(target) });
            } else {
                throw new Error(`${label} contains unsupported filesystem entry: ${absolutePath}`);
            }
        }
    }

    walk(root);
    return manifest;
}

function compareManifests(expected, actual, label) {
    const issues = [];
    const expectedByPath = new Map(expected.map((entry) => [entry.path, entry]));
    const actualByPath = new Map(actual.map((entry) => [entry.path, entry]));
    for (const [path, entry] of expectedByPath) {
        const found = actualByPath.get(path);
        if (!found) {
            issues.push(`${label}: missing in target: ${path}`);
        } else if (entry.type !== found.type) {
            issues.push(`${label}: type mismatch: ${path} (${entry.type} != ${found.type})`);
        } else if (entry.sha256 !== found.sha256 || entry.size !== found.size) {
            issues.push(`${label}: stale/content mismatch: ${path}`);
        }
    }
    for (const path of actualByPath.keys()) {
        if (!expectedByPath.has(path)) issues.push(`${label}: extra in target: ${path}`);
    }
    if (issues.length <= 10) return issues;
    return [
        ...issues.slice(0, 10),
        `${label}: ... ${issues.length - 10} additional manifest difference(s)`,
    ];
}

function loadBuilderServerExclusions(builderConfigPath) {
    requireFile(builderConfigPath, 'electron-builder config');
    const config = YAML.parse(readFileSync(builderConfigPath, 'utf8'));
    const resources = Array.isArray(config?.extraResources) ? config.extraResources : [];
    const serverResource = resources.find((entry) => entry?.from === 'sidecar/server' && entry?.to === 'server');
    if (!serverResource || !Array.isArray(serverResource.filter)) {
        throw new Error(`electron-builder server extraResources filter missing: ${builderConfigPath}`);
    }
    const exclusions = serverResource.filter
        .filter((pattern) => typeof pattern === 'string' && pattern.startsWith('!'))
        .map((pattern) => pattern.slice(1));
    if (exclusions.length === 0) {
        throw new Error(`electron-builder server exclusions missing: ${builderConfigPath}`);
    }
    return exclusions;
}

function findForbiddenMarkers(content, markers) {
    const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
    return markers.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
}

function scanBuffer(content, label, markers) {
    return findForbiddenMarkers(content, markers).map((marker) => `${label}: forbidden marker "${marker}"`);
}

function scanTree(root, manifest, label, markers) {
    const issues = [];
    for (const entry of manifest) {
        if (entry.type !== 'file' || !SCANNABLE_EXTENSIONS.has(extname(entry.path).toLowerCase())) continue;
        issues.push(...scanBuffer(readFileSync(join(root, entry.path)), `${label}/${entry.path}`, markers));
    }
    return issues;
}

function resolveArtifactPaths(options = {}) {
    const projectRoot = resolve(options.projectRoot ?? fileURLToPath(new URL('..', import.meta.url)));
    const appPath = resolve(projectRoot, options.appPath ?? DEFAULT_APP_RELATIVE_PATH);
    const packagedResources = join(appPath, 'Contents', 'Resources');
    return {
        projectRoot,
        appPath,
        builderConfig: join(projectRoot, 'electron', 'electron-builder.yml'),
        sourcePublicDist: join(projectRoot, 'public', 'dist'),
        sidecarRoot: join(projectRoot, 'electron', 'sidecar', 'server'),
        sidecarPublicDist: join(projectRoot, 'electron', 'sidecar', 'server', 'public', 'dist'),
        sidecarServerDist: join(projectRoot, 'electron', 'sidecar', 'server', 'dist'),
        packagedServerRoot: join(packagedResources, 'server'),
        packagedPublicDist: join(packagedResources, 'server', 'public', 'dist'),
        packagedServerDist: join(packagedResources, 'server', 'dist'),
        outMain: join(projectRoot, 'electron', 'out', 'main', 'index.js'),
        outPreload: join(projectRoot, 'electron', 'out', 'preload', 'index.js'),
        asarPath: join(packagedResources, 'app.asar'),
    };
}

async function defaultReadAsarEntry(asarPath, entryPath) {
    const { extractFile } = await import('@electron/asar');
    try {
        return extractFile(asarPath, entryPath);
    } catch (error) {
        throw new Error(`app.asar entry missing or unreadable: ${entryPath} (${error instanceof Error ? error.message : String(error)})`);
    }
}

async function checkElectronRuntimeParity(options = {}) {
    const paths = resolveArtifactPaths(options);
    const readAsarEntry = options.readAsarEntry ?? defaultReadAsarEntry;
    const issues = [];
    const manifests = {};
    let exclusions = [];

    const capture = (key, operation) => {
        try {
            const value = operation();
            if (key) manifests[key] = value;
            return value;
        } catch (error) {
            issues.push(error instanceof Error ? error.message : String(error));
            return null;
        }
    };

    try {
        exclusions = loadBuilderServerExclusions(paths.builderConfig);
    } catch (error) {
        issues.push(error instanceof Error ? error.message : String(error));
    }

    const sourcePublic = capture('sourcePublic', () => createTreeManifest(paths.sourcePublicDist, { label: 'source public/dist' }));
    const sidecarPublic = capture('sidecarPublic', () => createTreeManifest(paths.sidecarPublicDist, { label: 'sidecar public/dist' }));
    const sidecarPublicFiltered = exclusions.length > 0
        ? capture('sidecarPublicFiltered', () => createTreeManifest(paths.sidecarPublicDist, { label: 'filtered sidecar public/dist', excludePatterns: exclusions }))
        : null;
    const packagedPublic = capture('packagedPublic', () => createTreeManifest(paths.packagedPublicDist, { label: 'packaged server public/dist' }));
    const sidecar = exclusions.length > 0
        ? capture('sidecar', () => createTreeManifest(paths.sidecarRoot, { label: 'filtered sidecar server', excludePatterns: exclusions }))
        : null;
    const packagedServer = capture('packagedServer', () => createTreeManifest(paths.packagedServerRoot, { label: 'packaged server' }));
    const sidecarDist = capture('sidecarDist', () => createTreeManifest(paths.sidecarServerDist, { label: 'sidecar server dist' }));
    const packagedDist = capture('packagedDist', () => createTreeManifest(paths.packagedServerDist, { label: 'packaged server dist' }));

    if (sourcePublic && sidecarPublic) issues.push(...compareManifests(sourcePublic, sidecarPublic, 'public/dist -> sidecar public/dist'));
    if (sidecarPublicFiltered && packagedPublic) issues.push(...compareManifests(sidecarPublicFiltered, packagedPublic, 'sidecar public/dist -> packaged server public/dist'));
    if (sidecar && packagedServer) issues.push(...compareManifests(sidecar, packagedServer, 'sidecar server -> packaged server'));

    let outMain = null;
    let outPreload = null;
    let asarMain = null;
    let asarPreload = null;
    for (const [path, label, assign] of [
        [paths.outMain, 'electron/out main', (value) => { outMain = value; }],
        [paths.outPreload, 'electron/out preload', (value) => { outPreload = value; }],
    ]) {
        try {
            requireFile(path, label);
            assign(readFileSync(path));
        } catch (error) {
            issues.push(error instanceof Error ? error.message : String(error));
        }
    }
    try {
        requireFile(paths.asarPath, 'packaged app.asar');
        asarMain = await readAsarEntry(paths.asarPath, 'out/main/index.js');
        asarPreload = await readAsarEntry(paths.asarPath, 'out/preload/index.js');
    } catch (error) {
        issues.push(error instanceof Error ? error.message : String(error));
    }

    if (outMain && asarMain && sha256(outMain) !== sha256(asarMain)) issues.push('electron/out main -> app.asar: stale/content mismatch: out/main/index.js');
    if (outPreload && asarPreload && sha256(outPreload) !== sha256(asarPreload)) issues.push('electron/out preload -> app.asar: stale/content mismatch: out/preload/index.js');

    for (const [content, label] of [
        [outMain, 'electron/out/main/index.js'],
        [outPreload, 'electron/out/preload/index.js'],
        [asarMain, 'app.asar:out/main/index.js'],
        [asarPreload, 'app.asar:out/preload/index.js'],
    ]) {
        if (content) issues.push(...scanBuffer(content, label, GLOBAL_RETIRED_MARKERS));
    }
    for (const [content, label] of [
        [outPreload, 'electron/out/preload/index.js'],
        [asarPreload, 'app.asar:out/preload/index.js'],
    ]) {
        if (content) issues.push(...scanBuffer(content, label, PRELOAD_MARKERS));
    }

    for (const [root, manifest, label] of [
        [paths.sourcePublicDist, sourcePublic, 'public/dist'],
        [paths.sidecarPublicDist, sidecarPublic, 'sidecar/public/dist'],
        [paths.packagedPublicDist, packagedPublic, 'packaged/server/public/dist'],
    ]) {
        if (manifest) {
            issues.push(...scanTree(root, manifest, label, GLOBAL_RETIRED_MARKERS));
            issues.push(...scanTree(root, manifest, label, PAGE_WORLD_MARKERS));
        }
    }
    for (const [root, manifest, label] of [
        [paths.sidecarServerDist, sidecarDist, 'sidecar/server/dist'],
        [paths.packagedServerDist, packagedDist, 'packaged/server/dist'],
    ]) {
        if (manifest) issues.push(...scanTree(root, manifest, label, GLOBAL_RETIRED_MARKERS));
    }

    if (issues.length > 0) throw new ArtifactParityError(issues);
    return {
        appPath: paths.appPath,
        builderExclusions: exclusions,
        fileCounts: Object.fromEntries(Object.entries(manifests).map(([key, manifest]) => [key, manifest.length])),
    };
}

function parseArgs(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--help' || argument === '-h') return { help: true };
        if (argument === '--root' || argument === '--app') {
            const value = argv[index + 1];
            if (!value || value.startsWith('-')) throw new Error(`${argument} requires a path`);
            options[argument === '--root' ? 'projectRoot' : 'appPath'] = value;
            index += 1;
            continue;
        }
        throw new Error(`unknown argument: ${argument}`);
    }
    return options;
}

async function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    if (options.help) {
        console.log('Usage: node scripts/check-electron-runtime-parity.mjs [--root <repo>] [--app <cli-jaw.app>]');
        console.log(`Default app: ${DEFAULT_APP_RELATIVE_PATH}`);
        return;
    }
    const report = await checkElectronRuntimeParity(options);
    console.log(`[electron-runtime-parity] OK ${report.appPath}`);
    console.log(`[electron-runtime-parity] manifests ${JSON.stringify(report.fileCounts)}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}

export {
    ArtifactParityError,
    DEFAULT_APP_RELATIVE_PATH,
    GLOBAL_RETIRED_MARKERS,
    PAGE_WORLD_MARKERS,
    PRELOAD_MARKERS,
    checkElectronRuntimeParity,
    compareManifests,
    createTreeManifest,
    findForbiddenMarkers,
    globToRegExp,
    loadBuilderServerExclusions,
    parseArgs,
    resolveArtifactPaths,
    scanBuffer,
    sha256,
};
