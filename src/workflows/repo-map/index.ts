import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';

export type RepoMapDefinitionKind = 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const' | 'method';

export interface RepoMapDefinition {
    file: string;
    line: number;
    kind: RepoMapDefinitionKind;
    name: string;
    refCount: number;
}

export interface RepoMapFile {
    path: string;
    gravity: number;
    definitions: RepoMapDefinition[];
}

export interface RepoMap {
    root: string;
    budgetTokens: number;
    scannedFiles: number;
    totalDefinitions: number;
    files: RepoMapFile[];
}

export interface BuildRepoMapOptions {
    budgetTokens?: number;
    maxDepth?: number;
}

const DEFAULT_BUDGET_TOKENS = 4096;
const DEFAULT_MAX_DEPTH = 12;
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'target', 'out', 'coverage']);
const METHOD_PREFIX = String.raw`(?:(?:public|private|protected|static|async|override|readonly|abstract)\s+)*`;
const RESERVED_METHOD_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'function']);

function shouldSkipDirectory(name: string): boolean {
    return name.startsWith('.') || SKIP_DIRS.has(name);
}

function isSourceFile(path: string): boolean {
    return SOURCE_EXTENSIONS.has(extname(path));
}

function findSourceFiles(root: string, maxDepth: number): string[] {
    if (!existsSync(root)) return [];
    const rootStat = statSync(root);
    if (rootStat.isFile()) return isSourceFile(root) ? [root] : [];
    if (!rootStat.isDirectory()) return [];

    const files: string[] = [];
    function walk(dir: string, depth: number) {
        if (depth > maxDepth) return;
        try {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const abs = join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (!shouldSkipDirectory(entry.name)) walk(abs, depth + 1);
                    continue;
                }
                if (entry.isFile() && isSourceFile(entry.name)) files.push(abs);
            }
        } catch {
            // Skip unreadable subtrees; the top-level CLI validates the requested root.
        }
    }

    walk(root, 0);
    return files.sort();
}

function countIdentifier(text: string, identifier: string): number {
    const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text.match(new RegExp(`\\b${escaped}\\b`, 'g'))?.length ?? 0;
}

function classBraceDelta(line: string): number {
    return (line.match(/{/g)?.length ?? 0) - (line.match(/}/g)?.length ?? 0);
}

function extractDefinitions(file: string, text: string): Omit<RepoMapDefinition, 'refCount'>[] {
    const definitions: Omit<RepoMapDefinition, 'refCount'>[] = [];
    const lines = text.split(/\r?\n/);
    let classDepth = 0;
    let blockDepth = 0;

    for (let index = 0; index < lines.length; index++) {
        const lineNumber = index + 1;
        const trimmed = lines[index]!.trim();
        const isTopLevel = blockDepth === 0;
        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) {
            const delta = classBraceDelta(trimmed);
            if (classDepth > 0) classDepth = Math.max(0, classDepth + delta);
            blockDepth = Math.max(0, blockDepth + delta);
            continue;
        }

        const classMatch = isTopLevel ? trimmed.match(/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\b/) : null;
        const functionMatch = isTopLevel ? trimmed.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/) : null;
        const interfaceMatch = isTopLevel ? trimmed.match(/^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/) : null;
        const typeMatch = isTopLevel ? trimmed.match(/^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/) : null;
        const enumMatch = isTopLevel ? trimmed.match(/^(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)\b/) : null;
        const constMatch = isTopLevel ? trimmed.match(/^(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/) : null;

        if (classMatch) definitions.push({ file, line: lineNumber, kind: 'class', name: classMatch[1]! });
        else if (functionMatch) definitions.push({ file, line: lineNumber, kind: 'function', name: functionMatch[1]! });
        else if (interfaceMatch) definitions.push({ file, line: lineNumber, kind: 'interface', name: interfaceMatch[1]! });
        else if (typeMatch) definitions.push({ file, line: lineNumber, kind: 'type', name: typeMatch[1]! });
        else if (enumMatch) definitions.push({ file, line: lineNumber, kind: 'enum', name: enumMatch[1]! });
        else if (constMatch) definitions.push({ file, line: lineNumber, kind: 'const', name: constMatch[1]! });
        else if (classDepth === 1) {
            const methodMatch = trimmed.match(new RegExp(`^${METHOD_PREFIX}(?:get\\s+|set\\s+)?([A-Za-z_$][\\w$]*)\\s*(?:<[^>]+>\\s*)?\\(`));
            const name = methodMatch?.[1];
            if (name && !RESERVED_METHOD_NAMES.has(name)) {
                definitions.push({ file, line: lineNumber, kind: 'method', name });
            }
        }

        const delta = classBraceDelta(trimmed);
        if (classMatch || classDepth > 0) classDepth = Math.max(0, classDepth + delta);
        blockDepth = Math.max(0, blockDepth + delta);
    }

    return definitions;
}

export function buildRepoMap(targetPath: string, options: BuildRepoMapOptions = {}): RepoMap {
    const root = resolve(targetPath);
    const budgetTokens = options.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
    const sourceFiles = findSourceFiles(root, options.maxDepth ?? DEFAULT_MAX_DEPTH);
    const fileTexts = sourceFiles.map((file) => ({
        file,
        rel: sourceFiles.length === 1 ? basename(file) : relative(root, file),
        text: readFileSync(file, 'utf8'),
    }));
    const corpus = fileTexts.map(({ text }) => text).join('\n');
    const definitions = fileTexts.flatMap(({ rel, text }) => extractDefinitions(rel, text));
    const rankedDefinitions: RepoMapDefinition[] = definitions.map((definition) => ({
        ...definition,
        refCount: countIdentifier(corpus, definition.name),
    }));

    const byFile = new Map<string, RepoMapDefinition[]>();
    for (const definition of rankedDefinitions) {
        const defs = byFile.get(definition.file) ?? [];
        defs.push(definition);
        byFile.set(definition.file, defs);
    }

    const files = [...byFile.entries()]
        .map(([path, defs]) => ({
            path,
            definitions: defs.sort((a, b) => a.line - b.line),
            gravity: defs.reduce((sum, definition) => sum + definition.refCount, 0),
        }))
        .sort((a, b) => b.gravity - a.gravity || a.path.localeCompare(b.path));

    return {
        root,
        budgetTokens,
        scannedFiles: sourceFiles.length,
        totalDefinitions: rankedDefinitions.length,
        files,
    };
}

export function renderRepoMap(repoMap: RepoMap): string {
    const maxChars = Math.max(repoMap.budgetTokens, 1) * 4;
    const lines = [
        `cli-jaw map: ${repoMap.root} (budget ${repoMap.budgetTokens} tokens; scanned ${repoMap.scannedFiles} files; ${repoMap.totalDefinitions} defs)`,
    ];

    for (const file of repoMap.files) {
        lines.push('');
        lines.push(file.path);
        for (const definition of file.definitions) {
            lines.push(`  ${definition.line}: ${definition.kind} ${definition.name}`);
        }
    }

    let output = lines.join('\n');
    if (output.length <= maxChars) return output;

    const cut = output.slice(0, Math.max(0, maxChars - 36));
    const lastNewline = cut.lastIndexOf('\n');
    output = `${cut.slice(0, lastNewline > 0 ? lastNewline : cut.length)}\n... (truncated to budget)`;
    return output;
}
