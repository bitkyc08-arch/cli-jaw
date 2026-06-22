// Import path resolution test — catches broken relative imports after refactoring
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');

function collectTsFiles(dir: string): string[] {
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== 'node_modules') {
            results.push(...collectTsFiles(full));
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
            results.push(full);
        }
    }
    return results;
}

// Match both static and dynamic imports: from './foo.js' or import('./foo.js')
const IMPORT_RE = /(?:from\s+['"]|import\s*\(\s*['"])(\.[^'"]+)['"]/g;

function extractImports(filePath: string) {
    const code = fs.readFileSync(filePath, 'utf8');
    const imports = [];
    let m;
    while ((m = IMPORT_RE.exec(code)) !== null) {
        imports.push({ specifier: m[1], line: code.slice(0, m.index).split('\n').length });
    }
    return imports;
}

// Scan src/ and server.ts + top-level TS
const srcFiles = collectTsFiles(SRC);
const serverTs = path.join(ROOT, 'server.ts');
const allFiles = fs.existsSync(serverTs) ? [serverTs, ...srcFiles] : srcFiles;

const broken = [];

for (const file of allFiles) {
    const imports = extractImports(file);
    for (const { specifier, line } of imports) {
        if (!specifier.startsWith('.')) continue; // skip bare specifiers
        const resolved = path.resolve(path.dirname(file), specifier);
        // NodeNext: .ts files use .js in import specifiers, so also check .ts equivalent.
        // Bundler resolution (src/lib/tui/tsconfig.json) also allows extensionless
        // specifiers, so accept '<path>.ts' / '<path>/index.ts' candidates too.
        const candidates = [
            resolved,
            resolved.endsWith('.js') ? resolved.replace(/\.js$/, '.ts') : `${resolved}.ts`,
            resolved.endsWith('.mjs') ? resolved.replace(/\.mjs$/, '.d.mts') : `${resolved}.d.mts`,
            `${resolved}.tsx`,
            path.join(resolved, 'index.ts'),
        ];
        if (!candidates.some(c => fs.existsSync(c))) {
            const rel = path.relative(ROOT, file);
            broken.push(`${rel}:${line} → ${specifier} (resolved: ${path.relative(ROOT, resolved)})`);
        }
    }
}

test('IMP-001: all relative imports resolve to existing files', () => {
    if (broken.length > 0) {
        assert.fail(
            `Found ${broken.length} broken import(s):\n` +
            broken.map(b => `  ✗ ${b}`).join('\n')
        );
    }
});
