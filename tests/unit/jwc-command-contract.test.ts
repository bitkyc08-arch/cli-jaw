import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { checkRetiredCommand } from '../../scripts/retired-runtime-package-smoke.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

test('retired jaw jwc rejects install/clean/doctor/help before repair, import or chat and preserves user data', () => {
    const owned = mkdtempSync(join(tmpdir(), 'jaw-retired-entry-'));
    const put = (file: string, text: string) => {
        const target = join(owned, file);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, text);
    };
    try {
        put('package.json', JSON.stringify({ name: 'cli-jaw', version: '0.0.0', type: 'module' }));
        // Execute the actual router with only its unrelated static dependencies
        // replaced by tripwires. No SDK, command modules, or provider is installed.
        put('bin/cli-jaw.js', transpileModule(readFileSync(join(root, 'bin/cli-jaw.ts'), 'utf8'), {
            compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
        }).outputText);
        put('src/core/path-expand.js', transpileModule(readFileSync(join(root, 'src/core/path-expand.ts'), 'utf8'), {
            compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
        }).outputText);
        put('bin/star-prompt.js', 'export function maybePromptGithubStar() { throw new Error("unexpected star prompt"); }');
        put('src/core/install-integrity.js', `
export function inspectInstallIntegrity() { throw new Error('unexpected installation inspection'); }
export function formatIntegrityReport() { throw new Error('unexpected installation report'); }
`);
        // Its presence makes an accidentally reordered native guard attempt a
        // child process; the shared smoke records and rejects that attempt.
        put('scripts/ensure-native-modules.cjs', 'throw new Error("unexpected native repair");');
        checkRetiredCommand(join(owned, 'bin/cli-jaw.js'));
    } finally {
        rmSync(owned, { recursive: true, force: true });
    }
});
