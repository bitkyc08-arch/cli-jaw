import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CLI_REGISTRY } from '../../cli/registry.js';
import { buildCliDetectionEnv, prioritizeCliCandidates, readProcessPath, selectSpawnableCliPath,
    type CliDetection } from '../../core/cli-detect.js';
import { splitPathList } from '../../core/runtime-path.js';
import { applyCliEnvDefaults, mergeEnvWindowsSafe } from '../../agent/spawn-env.js';
import type { CodeProviders } from '../provider.js';
import type { CodePermissionMode, CodeProviderCatalog, CodeProviderId } from '../wire.js';
import type { CodeProviderDependencies } from './acp.js';
import { createCodexCodeProvider } from './codex-app.js';
import { createClaudeCodeProvider } from './claude.js';
import { createCursorCodeProvider } from './cursor.js';
import { createGrokCodeProvider } from './grok.js';

const MODES: Record<CodeProviderId, CodePermissionMode[]> = {
    'codex-app': ['ask', 'auto', 'read-only'], claude: ['ask', 'auto'], cursor: ['ask', 'auto'], grok: ['auto'],
};

/** Filesystem-only discovery: catalogs must never execute a CLI or a login probe. */
function detect(binary: string): CliDetection {
    const env = buildCliDetectionEnv(readProcessPath());
    const extensions = process.platform === 'win32' ? ['.exe', '.com', '.cmd', '.bat'] : [''];
    const candidates = splitPathList(readProcessPath(env), process.platform)
        .flatMap(directory => extensions.map(extension => join(directory, binary + extension)))
        .filter(candidate => existsSync(candidate));
    return selectSpawnableCliPath(prioritizeCliCandidates(binary, candidates));
}

export interface CodeProviderFactories {
    acpSpawn?: Parameters<typeof createCursorCodeProvider>[2];
    codex?: Parameters<typeof createCodexCodeProvider>[1];
    claude?: Parameters<typeof createClaudeCodeProvider>[1];
    cursor?: Parameters<typeof createCursorCodeProvider>[1];
    grok?: Parameters<typeof createGrokCodeProvider>[1];
    detect?: (binary: string) => CliDetection;
}

export function createCodeProviders(factories: CodeProviderFactories = {}): CodeProviders {
    const dependencies = (id: CodeProviderId): CodeProviderDependencies => {
        const entry = CLI_REGISTRY[id];
        const binaryName = id === 'cursor' ? 'cursor-agent' : entry.binary;
        const detection = () => (factories.detect ?? detect)(binaryName);
        return {
            describe(): CodeProviderCatalog {
                const found = detection();
                return { id, label: entry.label, available: found.available && !!found.path,
                    reason: found.available && found.path ? null : 'Native CLI executable unavailable',
                    models: [...entry.models], defaultModel: entry.defaultModel,
                    defaultEffort: entry.defaultEffort || null, modelSource: 'registry',
                    capabilities: { resume: true, interrupt: true, permissions: true,
                        setModelMidSession: false, efforts: [...entry.efforts], permissionModes: [...MODES[id]] } };
            },
            binary() {
                const found = detection();
                if (!found.available || !found.path) throw new Error('code_provider_unavailable');
                return found.path;
            },
            environment() {
                const env = buildCliDetectionEnv(readProcessPath());
                return mergeEnvWindowsSafe(env, applyCliEnvDefaults(id, {}, env));
            },
        };
    };
    return Object.freeze({
        'codex-app': createCodexCodeProvider(dependencies('codex-app'), factories.codex),
        claude: createClaudeCodeProvider(dependencies('claude'), factories.claude),
        cursor: createCursorCodeProvider(dependencies('cursor'), factories.cursor, factories.acpSpawn),
        grok: createGrokCodeProvider(dependencies('grok'), factories.grok, factories.acpSpawn),
    });
}
