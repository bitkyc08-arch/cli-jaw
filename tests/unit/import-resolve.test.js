// Import path resolution test — catches broken relative imports after refactoring
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');

function collectJsFiles(dir) {
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== 'node_modules') {
            results.push(...collectJsFiles(full));
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            results.push(full);
        }
    }
    return results;
}

// Match both static and dynamic imports: from './foo.js' or import('./foo.js')
const IMPORT_RE = /(?:from\s+['"]|import\s*\(\s*['"])(\.[^'"]+)['"]/g;

function extractImports(filePath) {
    const code = fs.readFileSync(filePath, 'utf8');
    const imports = [];
    let m;
    while ((m = IMPORT_RE.exec(code)) !== null) {
        imports.push({ specifier: m[1], line: code.slice(0, m.index).split('\n').length });
    }
    return imports;
}

// Scan src/ and server.js + top-level JS
const srcFiles = collectJsFiles(SRC);
const serverJs = path.join(ROOT, 'server.js');
const allFiles = fs.existsSync(serverJs) ? [serverJs, ...srcFiles] : srcFiles;

const broken = [];

for (const file of allFiles) {
    const imports = extractImports(file);
    for (const { specifier, line } of imports) {
        if (!specifier.startsWith('.')) continue; // skip bare specifiers
        const resolved = path.resolve(path.dirname(file), specifier);
        if (!fs.existsSync(resolved)) {
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
