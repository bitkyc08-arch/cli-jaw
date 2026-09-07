import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Like electron-isolated-qa-startup.test.ts, execute actual startup source with
// explicit side-effect boundaries. This covers server.ts startup sequencing and
// settings persistence, not the imported config implementation or HTTP listening.
const source = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function callStatement(name: string) {
    const statement = parsed.statements.find(node => ts.isExpressionStatement(node)
        && ts.isCallExpression(node.expression) && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === name);
    assert.ok(statement, `actual startup ${name} boundary must exist`);
    return statement;
}
const start = callStatement('loadSettings').getStart(parsed);
const end = callStatement('regenerateB').end;
assert.ok(end > start, 'startup settings load precedes prompt generation');
const startup = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

type SavedSettings = { permissions: string | string[]; cli: string; workingDir: string };
for (const permission of ['safe', 'auto', ['read']] as const) {
    test(`actual server startup preserves saved ${JSON.stringify(permission)} through restart`, async () => {
        const root = mkdtempSync(join(tmpdir(), 'jaw-permission-startup-'));
        const settingsPath = join(root, 'settings.json');
        const initial = { permissions: permission, cli: 'claude', workingDir: root };
        const original = JSON.stringify(initial);
        writeFileSync(settingsPath, original);
        try {
            for (let boot = 0; boot < 2; boot++) {
                const settings: Partial<SavedSettings> = {};
                const generated: unknown[] = [];
                let saves = 0;
                let loaded = false;
                const noop = () => {};
                const context = {
                    settings, process: { env: {} },
                    loadSettings() { Object.assign(settings, JSON.parse(readFileSync(settingsPath, 'utf8'))); loaded = true; },
                    saveSettings(value: SavedSettings) { saves++; writeFileSync(settingsPath, JSON.stringify(value)); },
                    db: { prepare: () => ({ pluck: () => ({ get: () => 'ok' }) }) },
                    readDatabaseStorageStats: () => ({ pageCount: 0, freeRatio: 0, freelistCount: 0 }),
                    clearAllEmployeeSessions: { run: () => ({ changes: 0 }) },
                    // No real orphan cleanup or provider/toolchain access is admitted.
                    fs: { readdirSync: () => [], rmSync() { assert.fail('unexpected orphan deletion'); } },
                    join, console: { log: noop, warn: noop, error: noop },
                    syncMainSessionToSettings: noop, ensureMemoryRuntimeReady: noop,
                    hasSoulFile: () => false, refreshHostToolchain: noop,
                    initPromptFiles: noop,
                    regenerateB() {
                        assert.equal(loaded, true, 'prompt generation must follow persisted settings load');
                        generated.push(structuredClone(settings.permissions));
                    },
                };
                // Replace only the OS tmpdir import with a contained boundary. All
                // statements including any permission coercion run verbatim after TS erasure.
                const code = startup.replace("await import('node:os')", '({ tmpdir: () => fixtureTmp })');
                await runInNewContext(`(async () => { ${code} })()`, { ...context, fixtureTmp: root }, { timeout: 1000 });
                assert.deepEqual(settings.permissions, permission, `boot ${boot}: configured policy must survive startup`);
                assert.deepEqual(generated, [permission], `boot ${boot}: prompts must see the saved policy`);
                assert.equal(readFileSync(settingsPath, 'utf8'), original, `boot ${boot}: startup must not rewrite the saved policy`);
                assert.equal(saves, 0, `boot ${boot}: no forced permission migration`);
            }
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
}
