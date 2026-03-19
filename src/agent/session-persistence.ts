import { settings } from '../core/config.js';
import { updateSession } from '../core/db.js';

export type SessionPersistenceInput = {
    ownerGeneration: number;
    forceNew?: boolean;
    employeeSessionId?: string | null;
    sessionId?: string | null;
    isFallback?: boolean;
    code?: number | null;
    cli: string;
    model: string;
    effort: string;
    permissions?: string;
    workingDir?: string;
};

let sessionOwnershipGeneration = 0;

export function getSessionOwnershipGeneration(): number {
    return sessionOwnershipGeneration;
}

export function bumpSessionOwnershipGeneration(): number {
    sessionOwnershipGeneration += 1;
    return sessionOwnershipGeneration;
}

export function resetSessionOwnershipGenerationForTest(): void {
    sessionOwnershipGeneration = 0;
}

export function isCurrentSessionOwner(ownerGeneration: number): boolean {
    return ownerGeneration === sessionOwnershipGeneration;
}

export function shouldPersistMainSession(input: SessionPersistenceInput): boolean {
    if (input.forceNew || input.employeeSessionId || !input.sessionId || input.isFallback) return false;
    if (input.code !== undefined && input.code !== null && input.code !== 0) return false;
    return isCurrentSessionOwner(input.ownerGeneration);
}

export function persistMainSession(input: SessionPersistenceInput): boolean {
    if (!shouldPersistMainSession(input)) return false;
    updateSession.run(
        input.cli,
        input.sessionId,
        input.model,
        input.permissions || settings.permissions || 'auto',
        input.workingDir || settings.workingDir || '~',
        input.effort,
    );
    return true;
}
