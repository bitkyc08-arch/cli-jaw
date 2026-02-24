#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const checks = [
    {
        name: 'CLI registry has copilot',
        file: 'src/cli-registry.js',
        needle: 'copilot:',
    },
    {
        name: 'Server exposes /api/cli-registry',
        file: 'server.js',
        needle: "app.get('/api/cli-registry'",
    },
    {
        name: 'Settings page includes copilot model select',
        file: 'public/index.html',
        needle: 'id="modelCopilot"',
    },
    {
        name: 'Frontend loads registry from API',
        file: 'public/js/constants.js',
        needle: "fetch('/api/cli-registry')",
    },
    {
        name: 'Employees UI uses dynamic CLI keys',
        file: 'public/js/features/employees.js',
        needle: 'getCliKeys()',
    },
];

const rows = checks.map((item) => {
    const fullPath = path.join(ROOT, item.file);
    const content = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf8') : '';
    const ok = content.includes(item.needle);
    return { ...item, ok };
});

console.log('\nCopilot gap check\n');
for (const row of rows) {
    const icon = row.ok ? 'OK' : 'MISSING';
    console.log(`- ${icon}: ${row.name} (${row.file})`);
}

const failed = rows.filter(r => !r.ok);
if (failed.length) {
    console.error(`\nMissing ${failed.length} required item(s).`);
    process.exit(1);
}

console.log('\nAll checks passed.');
