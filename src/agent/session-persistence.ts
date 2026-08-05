import { settings } from '../core/config.js';
import { updateSession, upsertSessionBucket } from '../core/db.js';
import { resolveSessionBucket } from './args.js';

export type SessionOwnerToken = { global: number; scope: number };

export type SessionPersistenceInput = {
    persistenceOwner: SessionOwnerToken;
    scopeKey: string;
    forceNew?: boolean;
    employeeSessionId?: string | null;
    sessionId?: string | null;
    isFallback?: boolean;
    code?: number | null;
    wasKilled?: boolean;
    skipSessionPersist?: boolean;
    cli: string;
    model: string;
    provider?: string | null | undefined;
    resumeKey?: string | null;
    effort: string;
    permissions?: string;
    workingDir?: string;
    outputLen?: number | undefined;
    codexAppBucket?: string | undefined;
};

let globalGeneration = 0;
const scopeGenerations = new Map<string, number>();

export function getSessionOwnershipGeneration(scopeKey: string): SessionOwnerToken {
    return {
        global: globalGeneration,
        scope: scopeGenerations.get(scopeKey) ?? 0,
    };
}

export function bumpSessionOwnershipGeneration(): number {
    globalGeneration += 1;
    return globalGeneration;
}

export function bumpScopeSessionGeneration(scopeKey: string): number {
    const nextGeneration = (scopeGenerations.get(scopeKey) ?? 0) + 1;
    scopeGenerations.set(scopeKey, nextGeneration);
    return nextGeneration;
}

export function resetSessionOwnershipGenerationForTest(): void {
    globalGeneration = 0;
    scopeGenerations.clear();
}

export function isCurrentSessionOwner(token: SessionOwnerToken, scopeKey: string): boolean {
    return token.global === globalGeneration
        && token.scope === (scopeGenerations.get(scopeKey) ?? 0);
}

export function shouldPersistMainSession(input: SessionPersistenceInput): boolean {
    if (input.skipSessionPersist) return false;
    if (input.forceNew || input.employeeSessionId || !input.sessionId || input.isFallback) return false;
    if (input.cli === 'ai-e' && input.provider !== 'claude' && input.provider !== 'kiro' && input.provider !== 'codex' && input.provider !== 'grok') return false;
    // User-initiated kill (SIGTERM/SIGKILL) yields exit codes like 143/137/1 depending on
    // the CLI's signal handler. Allow persistence when wasKilled=true so resume works for
    // CLIs (claude, copilot) that don't translate SIGTERM to exit 0.
    // claude-e and ai-e's Claude PTY provider use exit code 2 for graceful SIGINT interrupt.
    const isGracefulInterrupt = input.code === 2
        && (input.cli === 'claude-e' || (input.cli === 'ai-e' && (input.provider === 'claude' || input.provider === 'codex' || input.provider === 'grok')));
    if (
        input.code !== undefined && input.code !== null && input.code !== 0
        && !input.wasKilled && !isGracefulInterrupt
    ) return false;
    return isCurrentSessionOwner(input.persistenceOwner, input.scopeKey);
}

export function persistMainSession(input: SessionPersistenceInput): boolean {
    const codexAppBucket = input.codexAppBucket;
    if (
        codexAppBucket !== undefined
        && (
            typeof codexAppBucket !== 'string'
            || !codexAppBucket.startsWith('codex-app:')
            || codexAppBucket.slice('codex-app:'.length).trim().length === 0
        )
    ) {
        console.warn('[jaw:session] rejected invalid codexAppBucket before persistence');
        return false;
    }
    if (!shouldPersistMainSession(input)) return false;
    updateSession.run(
        input.cli,
        input.sessionId,
        input.model,
        input.permissions || settings["permissions"] || 'auto',
        input.workingDir || settings["workingDir"] || '~',
        input.effort,
    );
    // Mirror into per-bucket table so codex-spark keeps a session independent from
    // plain codex (gpt-5.4 etc.) — avoids 'thread/resume failed: no rollout found'
    // on cross-model toggles.
    const bucket = codexAppBucket ?? resolveSessionBucket(input.cli, input.model, input.provider);
    if (bucket && input.sessionId) {
        upsertSessionBucket.run(bucket, input.sessionId, input.model, input.resumeKey || null, input.outputLen ?? 0);
    }
    return true;
}
