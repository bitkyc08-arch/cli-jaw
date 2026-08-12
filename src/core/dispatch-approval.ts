import { createHash, randomUUID } from 'node:crypto';
import { log } from './logger.js';

export const DEFAULT_DISPATCH_APPROVAL_TTL_SECONDS = 120;
export const MAX_DISPATCH_APPROVAL_TTL_SECONDS = 300;

export type DispatchApprovalPlatform = 'slack' | 'telegram' | 'discord';

export type DispatchApprovalScope = {
    target: { kind: 'agent' | 'virtual'; name: string };
    projectRoot: string;
    taskDigest: string;
    mutable: boolean;
    scope: string | null;
    fanOutCap: number;
    audience: string;
};

export type DispatchApprovalStatus = 'pending' | 'approved' | 'cancelled' | 'expired' | 'failed' | 'completed';

export type DispatchApprovalRecord = DispatchApprovalScope & {
    jti: string;
    digest: string;
    generation: string;
    createdAt: number;
    expiresAt: number;
    status: DispatchApprovalStatus;
    approvedBy?: { platform: DispatchApprovalPlatform; senderId: string };
    outcome?: unknown;
    error?: string;
};

type PendingInternal = DispatchApprovalRecord & {
    onApproved?: (record: DispatchApprovalRecord) => Promise<unknown>;
};

export type CreatePendingDispatchInput = Omit<DispatchApprovalScope, 'taskDigest' | 'audience'> & {
    task: string;
    ttlSeconds?: number;
    employeeMarker?: boolean;
    onApproved?: (record: DispatchApprovalRecord) => Promise<unknown>;
};

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function publicRecord(record: PendingInternal): DispatchApprovalRecord {
    const { onApproved: _onApproved, ...safe } = record;
    return { ...safe };
}

export class DispatchApprovalStore {
    readonly generation: string;
    readonly audience: string;
    private readonly records = new Map<string, PendingInternal>();

    constructor(
        private readonly now: () => number = Date.now,
        generation = randomUUID(),
    ) {
        this.generation = generation;
        this.audience = `cli-jaw:${generation}`;
    }

    create(input: CreatePendingDispatchInput): DispatchApprovalRecord {
        if (input.employeeMarker) throw new Error('employee_dispatch_approval_forbidden');
        const ttlSeconds = Number.isFinite(input.ttlSeconds)
            ? Math.min(MAX_DISPATCH_APPROVAL_TTL_SECONDS, Math.max(1, Math.floor(input.ttlSeconds!)))
            : DEFAULT_DISPATCH_APPROVAL_TTL_SECONDS;
        const scope: DispatchApprovalScope = {
            target: input.target,
            projectRoot: input.projectRoot,
            taskDigest: sha256(input.task),
            mutable: input.mutable,
            scope: input.scope,
            fanOutCap: input.fanOutCap,
            audience: this.audience,
        };
        const digest = sha256(canonicalJson(scope));
        const createdAt = this.now();
        const record: PendingInternal = {
            ...scope,
            jti: randomUUID(),
            digest,
            generation: this.generation,
            createdAt,
            expiresAt: createdAt + ttlSeconds * 1000,
            status: 'pending',
            ...(input.onApproved ? { onApproved: input.onApproved } : {}),
        };
        this.records.set(record.jti, record);
        log.info(`[dispatch-approval:create] jti=${record.jti} digest=${digest} expiresAt=${record.expiresAt}`);
        return publicRecord(record);
    }

    get(jti: string): DispatchApprovalRecord | null {
        const record = this.records.get(jti);
        if (!record) return null;
        this.expire(record);
        return publicRecord(record);
    }

    cancel(jti: string, digest: string): boolean {
        const record = this.records.get(jti);
        if (!record || record.status !== 'pending' || record.digest !== digest) return false;
        record.status = 'cancelled';
        log.info(`[dispatch-approval:cancel] jti=${jti} digest=${digest}`);
        return true;
    }

    consume(input: {
        jti: string;
        digest: string;
        audience?: string;
        platform: DispatchApprovalPlatform;
        senderId: string;
    }): { ok: true; record: DispatchApprovalRecord } | { ok: false; reason: string } {
        const record = this.records.get(input.jti);
        if (!record) return { ok: false, reason: 'not_found' };
        this.expire(record);
        if (record.status !== 'pending') return { ok: false, reason: record.status };
        if (record.generation !== this.generation || record.audience !== this.audience) {
            return { ok: false, reason: 'restart_void' };
        }
        if (input.audience !== undefined && input.audience !== record.audience) {
            return { ok: false, reason: 'audience_mismatch' };
        }
        if (input.digest !== record.digest) return { ok: false, reason: 'digest_mismatch' };

        // No await occurs before this state transition. In one Node process this is
        // the atomic test-and-set that makes concurrent approvals single-use.
        record.status = 'approved';
        record.approvedBy = { platform: input.platform, senderId: input.senderId };
        log.info(`[dispatch-approval:consume] jti=${record.jti} digest=${record.digest} platform=${input.platform} sender=${input.senderId}`);
        if (record.onApproved) {
            void record.onApproved(publicRecord(record)).then(
                outcome => {
                    record.outcome = outcome;
                    record.status = 'completed';
                    log.info(`[dispatch-approval:complete] jti=${record.jti} digest=${record.digest}`);
                },
                error => {
                    record.error = error instanceof Error ? error.message : String(error);
                    record.status = 'failed';
                    log.warn(`[dispatch-approval:failed] jti=${record.jti} digest=${record.digest} error=${record.error}`);
                },
            );
        }
        return { ok: true, record: publicRecord(record) };
    }

    private expire(record: PendingInternal): void {
        if (record.status === 'pending' && this.now() >= record.expiresAt) {
            record.status = 'expired';
            log.info(`[dispatch-approval:expire] jti=${record.jti} digest=${record.digest}`);
        }
    }
}

export function formatDispatchApprovalMessage(record: DispatchApprovalRecord): string {
    return [
        'cli-jaw dispatch approval requested',
        `JTI: ${record.jti}`,
        `Digest: ${record.digest}`,
        `Target: ${record.target.kind}:${record.target.name}`,
        `Project root: ${record.projectRoot}`,
        `Task digest: ${record.taskDigest}`,
        `Mutable scope: ${record.mutable ? (record.scope || record.projectRoot) : 'read-only'}`,
        `Fan-out cap: ${record.fanOutCap}`,
        `Audience: ${record.audience}`,
        `Expires: ${new Date(record.expiresAt).toISOString()}`,
        '',
        `Approve: approve ${record.jti} ${record.digest}`,
        `Cancel: cancel ${record.jti} ${record.digest}`,
    ].join('\n');
}

export const dispatchApprovalStore = new DispatchApprovalStore();
