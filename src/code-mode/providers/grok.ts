import type { spawn } from 'node:child_process';
import { createGrokSession } from '../../agent/runtime/acp/grok-session.js';
import { grokUsage } from '../../agent/runtime/acp/grok-events.js';
import type { CodeProvider } from '../provider.js';
import { admitCodeOpen, codeOwnedSpawn, CODE_PROMPT_TIMEOUT_MS, openCodeAcp, type CodeProviderDependencies } from './acp.js';

export function createGrokCodeProvider(dependencies: CodeProviderDependencies,
    create: typeof createGrokSession = createGrokSession, spawnImpl?: typeof spawn): CodeProvider {
    return {
        id: 'grok', describe: dependencies.describe,
        async open(options) {
            admitCodeOpen(options, dependencies);
            if (options.permissionMode !== 'auto') throw new Error('code_provider_policy_unsupported');
            return openCodeAcp(options, 'grok', failed => create({
                binary: dependencies.binary(), env: dependencies.environment(), cwd: options.cwd,
                model: options.model, effort: options.effort, resumeSessionId: options.nativeCursor,
                signal: options.signal, permissions: 'auto', registry: options.registry,
                promptTimeoutMs: CODE_PROMPT_TIMEOUT_MS, failed,
                spawnImpl: codeOwnedSpawn(options, spawnImpl),
            }), grokUsage);
        },
    };
}
