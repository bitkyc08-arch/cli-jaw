import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch'] as const;
const METHOD_ORDER = new Map(HTTP_METHODS.map((method, index) => [method.toUpperCase(), index]));
const DYNAMIC_PATH = '<dynamic>';

export type RouteMethod = Uppercase<(typeof HTTP_METHODS)[number]>;

export type RouteEntry = {
    method: RouteMethod;
    path: string;
    file: string;
    line: number;
};

export type RoutesSection = {
    routes: RouteEntry[];
    total: number;
    apiTotal: number;
};

export type ManagerRoutesSection = Omit<RoutesSection, 'apiTotal'>;

export type RoutesInventory = {
    core: RoutesSection;
    manager: ManagerRoutesSection;
};

type RouteCall = RouteEntry & {
    target: 'app' | 'router';
};

type MountCall = {
    prefix: string;
    factoryName: string;
    file: string;
};

type RegistrarCall = {
    name: string;
    file: string;
};

type SourceInfo = {
    sourceFile: ts.SourceFile;
    imports: Map<string, string>;
    routeCalls: RouteCall[];
    mounts: MountCall[];
    registrars: RegistrarCall[];
};

type CollectOptions = {
    entryFiles: string[];
    includeFiles: string[];
    includeAppFromResolvedRegistrars: boolean;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function toRepoPath(file: string): string {
    return relative(repoRoot, file).replaceAll('\\', '/');
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
    return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function routeMethodName(name: string): RouteMethod | null {
    const lower = name.toLowerCase();
    return HTTP_METHODS.includes(lower as (typeof HTTP_METHODS)[number])
        ? lower.toUpperCase() as RouteMethod
        : null;
}

function pathLiteral(node: ts.Expression | undefined): string {
    if (!node) return DYNAMIC_PATH;
    if (ts.isStringLiteralLike(node)) return node.text.split('?')[0] || '/';
    return DYNAMIC_PATH;
}

function joinRoutePath(prefix: string, routePath: string): string {
    if (prefix === DYNAMIC_PATH || routePath === DYNAMIC_PATH) return DYNAMIC_PATH;
    const cleanPrefix = prefix === '/' ? '' : prefix.replace(/\/+$/, '');
    const cleanRoute = routePath === '/' ? '' : routePath.startsWith('/') ? routePath : `/${routePath}`;
    return `${cleanPrefix}${cleanRoute}` || '/';
}

function resolveImportPath(fromFile: string, specifier: string): string | null {
    if (!specifier.startsWith('.')) return null;
    const base = resolve(dirname(fromFile), specifier);
    const candidates = [
        base,
        base.replace(/\.js$/, '.ts'),
        `${base}.ts`,
        join(base, 'index.ts'),
    ];
    return candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

function collectTsFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectTsFiles(full));
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
            files.push(full);
        }
    }
    return files.sort();
}

function createSourceInfo(file: string): SourceInfo {
    const sourceText = readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const imports = new Map<string, string>();
    const routeCalls: RouteCall[] = [];
    const mounts: MountCall[] = [];
    const registrars: RegistrarCall[] = [];

    function visit(node: ts.Node): void {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
            const resolved = resolveImportPath(file, node.moduleSpecifier.text);
            const clause = node.importClause;
            if (resolved && clause) {
                if (clause.name) imports.set(clause.name.text, resolved);
                const namedBindings = clause.namedBindings;
                if (namedBindings && ts.isNamedImports(namedBindings)) {
                    for (const element of namedBindings.elements) {
                        imports.set(element.name.text, resolved);
                    }
                }
            }
        }

        if (ts.isCallExpression(node)) {
            collectCall(node);
        }

        ts.forEachChild(node, visit);
    }

    function collectCall(node: ts.CallExpression): void {
        const expression = node.expression;
        if (ts.isPropertyAccessExpression(expression)) {
            const method = routeMethodName(expression.name.text);
            if (method) {
                const target = routeTarget(expression.expression);
                if (target) {
                    routeCalls.push({
                        method,
                        path: pathLiteral(node.arguments[0]),
                        file: toRepoPath(file),
                        line: lineOf(sourceFile, node),
                        target,
                    });
                }
                return;
            }

            if (expression.name.text === 'use' && node.arguments.length >= 2) {
                const prefix = pathLiteral(node.arguments[0]);
                const factoryName = findFactoryName([...node.arguments].slice(1));
                if (factoryName) mounts.push({ prefix, factoryName, file });
            }
            return;
        }

        if (ts.isIdentifier(expression) && /^register[A-Z].*Routes$/.test(expression.text)) {
            registrars.push({ name: expression.text, file });
        }
    }

    visit(sourceFile);
    return { sourceFile, imports, routeCalls, mounts, registrars };
}

function routeTarget(expression: ts.Expression): 'app' | 'router' | null {
    if (ts.isIdentifier(expression)) {
        if (expression.text === 'app') return 'app';
        if (expression.text === 'router') return 'router';
    }
    if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'router') {
        return 'router';
    }
    return null;
}

function findFactoryName(args: ts.Expression[]): string | null {
    for (const arg of args) {
        if (ts.isCallExpression(arg) && ts.isIdentifier(arg.expression)) return arg.expression.text;
    }
    return null;
}

function buildSourceCache(files: string[]): Map<string, SourceInfo> {
    const cache = new Map<string, SourceInfo>();
    for (const file of files) {
        cache.set(file, createSourceInfo(file));
    }
    return cache;
}

function getSourceInfo(cache: Map<string, SourceInfo>, file: string): SourceInfo {
    let info = cache.get(file);
    if (!info) {
        info = createSourceInfo(file);
        cache.set(file, info);
    }
    return info;
}

function collectRoutes(options: CollectOptions): RouteEntry[] {
    const cache = buildSourceCache([...new Set([...options.entryFiles, ...options.includeFiles])]);
    const routes: RouteEntry[] = [];
    const processedRegistrarFiles = new Set<string>();
    const processedMounts = new Set<string>();

    for (const file of options.includeFiles) {
        const info = getSourceInfo(cache, file);
        routes.push(...info.routeCalls.filter(route => route.target === 'app').map(stripTarget));
    }

    const processRegistrarFile = (file: string): void => {
        if (processedRegistrarFiles.has(file)) return;
        processedRegistrarFiles.add(file);
        const info = getSourceInfo(cache, file);
        if (options.includeAppFromResolvedRegistrars) {
            routes.push(...info.routeCalls.filter(route => route.target === 'app').map(stripTarget));
        }
        processMounts(info);
        for (const registrar of info.registrars) {
            const targetFile = info.imports.get(registrar.name);
            if (targetFile) processRegistrarFile(targetFile);
        }
    };

    const processMounts = (info: SourceInfo): void => {
        for (const mount of info.mounts) {
            const targetFile = info.imports.get(mount.factoryName) ?? mount.file;
            const key = `${mount.file}:${mount.prefix}:${mount.factoryName}:${targetFile}`;
            if (processedMounts.has(key)) continue;
            processedMounts.add(key);
            const targetInfo = getSourceInfo(cache, targetFile);
            routes.push(...targetInfo.routeCalls
                .filter(route => route.target === 'router')
                .map(route => ({
                    method: route.method,
                    path: joinRoutePath(mount.prefix, route.path),
                    file: route.file,
                    line: route.line,
                })));
            processMounts(targetInfo);
        }
    };

    for (const file of options.entryFiles) {
        const info = getSourceInfo(cache, file);
        routes.push(...info.routeCalls.filter(route => route.target === 'app').map(stripTarget));
        processMounts(info);
        for (const registrar of info.registrars) {
            const targetFile = info.imports.get(registrar.name);
            if (targetFile) processRegistrarFile(targetFile);
        }
    }

    return sortRoutes(dedupeRoutes(routes));
}

function stripTarget(route: RouteCall): RouteEntry {
    return {
        method: route.method,
        path: route.path,
        file: route.file,
        line: route.line,
    };
}

function routeKey(route: RouteEntry): string {
    return `${route.method} ${route.path}`;
}

function dedupeRoutes(routes: RouteEntry[]): RouteEntry[] {
    const byEndpoint = new Map<string, RouteEntry>();
    for (const route of routes) {
        const key = routeKey(route);
        const existing = byEndpoint.get(key);
        if (!existing || compareRoutes(route, existing) < 0) {
            byEndpoint.set(key, route);
        }
    }
    return [...byEndpoint.values()];
}

function sortRoutes(routes: RouteEntry[]): RouteEntry[] {
    return [...routes].sort(compareRoutes);
}

function compareRoutes(a: RouteEntry, b: RouteEntry): number {
    return a.path.localeCompare(b.path)
        || ((METHOD_ORDER.get(a.method) ?? 99) - (METHOD_ORDER.get(b.method) ?? 99))
        || a.method.localeCompare(b.method)
        || a.file.localeCompare(b.file)
        || a.line - b.line;
}

function section(routes: RouteEntry[]): RoutesSection {
    return {
        routes,
        total: routes.length,
        // Legacy structure/check-doc-drift.sh calls every handler except GET /
        // an API endpoint, including /media/:filename. Preserve that parity.
        apiTotal: routes.filter(route => !(route.method === 'GET' && route.path === '/')).length,
    };
}

function managerSection(routes: RouteEntry[]): ManagerRoutesSection {
    return {
        routes,
        total: routes.length,
    };
}

export async function extractRoutes(): Promise<RoutesInventory> {
    const coreRoutesDir = join(repoRoot, 'src', 'routes');
    const managerRoutesDir = join(repoRoot, 'src', 'manager', 'routes');
    const coreRoutes = collectRoutes({
        entryFiles: [join(repoRoot, 'server.ts')],
        includeFiles: collectTsFiles(coreRoutesDir),
        includeAppFromResolvedRegistrars: true,
    });
    const managerRoutes = collectRoutes({
        entryFiles: [join(repoRoot, 'src', 'manager', 'server.ts')],
        includeFiles: collectTsFiles(managerRoutesDir),
        includeAppFromResolvedRegistrars: true,
    });
    return {
        core: section(coreRoutes),
        manager: managerSection(managerRoutes),
    };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const inventory = await extractRoutes();
    console.log(JSON.stringify(inventory, null, 2));
}
