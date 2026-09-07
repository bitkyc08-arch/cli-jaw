import type { spawn } from 'node:child_process';
import { createCursorSession } from '../../agent/runtime/acp/cursor-session.js';
import type { CodeProvider } from '../provider.js';
import { admitCodeOpen, codeOwnedSpawn, CODE_PROMPT_TIMEOUT_MS, openCodeAcp, type CodeProviderDependencies } from './acp.js';

export function createCursorCodeProvider(dependencies: CodeProviderDependencies,
    create: typeof createCursorSession = createCursorSession, spawnImpl?: typeof spawn): CodeProvider {
    return {
        id: 'cursor', describe: dependencies.describe,
        async open(options) {
            admitCodeOpen(options, dependencies);
            return openCodeAcp(options, 'cursor', failed => create({
                binary: dependencies.binary(), env: dependencies.environment(), cwd: options.cwd,
                model: options.model, effort: options.effort, resumeSessionId: options.nativeCursor,
                signal: options.signal, permissions: options.permissionMode === 'auto' ? 'auto' : 'safe',
                registry: options.registry, promptTimeoutMs: CODE_PROMPT_TIMEOUT_MS, failed,
                spawnImpl: codeOwnedSpawn(options, spawnImpl),
            }));
        },
    };
}
