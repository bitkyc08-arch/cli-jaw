import type { RuntimeEvent, RuntimeEventBody } from '../../../shared/runtime-contract.js';
import { runtimeRequests, type RuntimeRequests, type RuntimeRequestBinding } from '../requests.js';
import type { AcpConnection } from './connection.js';
import type { RpcFrame, RpcId } from './wire.js';
import { automaticPermission, normalizeNativePermissions, permissionResponse, preparePermissionRequest, validatedPermissionParams } from './permissions.js';

export interface AcpRequestOwner {
    nativeSessionId: string;
    binding: RuntimeRequestBinding;
    parentItemId?: string;
    isCurrent(): boolean;
    /** Must be bound to the captured turn, never the subsequently active turn. */
    emit(body: RuntimeEventBody): RuntimeEvent | null;
}
type Work = { id: RpcId; runId: string; cancelled: boolean; selectedReplyInFlight: boolean; cancel?: () => void };
const CALLBACK_LIMIT = 32;

/** Connection-scoped callback owner. Human waits never block notification parsing. */
export class AcpCallbacks {
    private readonly active = new Map<RpcId, Work>();
    private readonly permissions: ReturnType<typeof normalizeNativePermissions>;
    private readonly registry: RuntimeRequests;
    private disposed = false;
    private cancelledRunId: string | null = null;

    constructor(private connection: AcpConnection, private options: {
        permissions: unknown; getOwner(): AcpRequestOwner | null; registry?: RuntimeRequests;
    }) {
        this.permissions = normalizeNativePermissions(options.permissions);
        this.registry = options.registry ?? runtimeRequests;
    }

    handle(frame: RpcFrame): void {
        if (!('method' in frame) || !('id' in frame) || this.disposed || !this.connection.alive) return;
        if (this.active.has(frame.id)) {
            this.dispose();
            void this.connection.refuse(frame.id, -32600, 'Duplicate request').catch(() => undefined)
                .finally(() => this.connection.close(new Error('acp_duplicate_request')));
            return;
        }
        let owner: AcpRequestOwner | null;
        try { owner = this.captureOwner(); }
        catch { this.fatal(new Error('acp_callback_owner_failed')); return; }
        if (!owner || !this.current(owner)) { this.refuse(frame.id, -32600, 'No active turn'); return; }
        if (this.cancelledRunId !== owner.binding.runId) this.cancelledRunId = null;
        if (this.active.size >= CALLBACK_LIMIT) { this.refuse(frame.id, -32000, 'Request capacity reached'); return; }
        const work: Work = { id: frame.id, runId: owner.binding.runId,
            cancelled: this.cancelledRunId === owner.binding.runId, selectedReplyInFlight: false };
        this.active.set(frame.id, work);
        if (frame.method !== 'session/request_permission') {
            this.track(work, this.connection.refuse(work.id, -32601, 'Client method unsupported'));
            return;
        }
        let params: ReturnType<typeof validatedPermissionParams>;
        try { params = validatedPermissionParams(frame.params, owner.nativeSessionId); }
        catch {
            this.track(work, this.connection.refuse(work.id, -32602, 'Invalid permission request'));
            return;
        }
        // Do not retain an arbitrary multi-megabyte raw frame during a human wait.
        this.track(work, this.permission(work, owner, params));
    }

    cancelRun(runId: string): void {
        let owner: AcpRequestOwner | null;
        try { owner = this.captureOwner(); }
        catch { this.fatal(new Error('acp_callback_owner_failed')); return; }
        if (owner?.binding.runId === runId) this.cancelledRunId = runId;
        const works = [...this.active.values()].filter(work => work.runId === runId);
        for (const work of works) work.cancelled = true;
        for (const work of works) work.cancel?.();
        if (works.some(work => work.selectedReplyInFlight)) this.fatal(new Error('acp_selected_reply_cancelled'));
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        const works = [...this.active.values()];
        for (const work of works) work.cancelled = true;
        for (const work of works) work.cancel?.();
        this.active.clear();
        if (works.some(work => work.selectedReplyInFlight)) this.connection.close(new Error('acp_selected_reply_cancelled'));
    }

    private captureOwner(): AcpRequestOwner | null {
        const source = this.options.getOwner();
        if (!source) return null;
        const { runId, sessionId, scope, turnId } = source.binding;
        return { nativeSessionId: source.nativeSessionId, binding: { runId, sessionId, scope, turnId },
            ...(source.parentItemId === undefined ? {} : { parentItemId: source.parentItemId }),
            isCurrent: source.isCurrent, emit: source.emit };
    }
    private current(owner: AcpRequestOwner): boolean {
        try { return !this.disposed && this.connection.alive && owner.isCurrent() === true; }
        catch { return false; }
    }
    private emit(owner: AcpRequestOwner, body: RuntimeEventBody): RuntimeEvent | null {
        try { return owner.emit(body); } catch { return null; }
    }
    private refuse(id: RpcId, code: number, message: string): void {
        void this.connection.refuse(id, code, message).catch(() => this.fatal(new Error('acp_callback_write_failed')));
    }
    private track(work: Work, operation: Promise<void>): void {
        void operation.catch(() => this.fatal(new Error('acp_callback_failed'))).finally(() => {
            if (this.active.get(work.id) === work) this.active.delete(work.id);
        });
    }
    private fatal(error: Error): void {
        this.connection.close(error);
        this.dispose();
    }

    private async reply(work: Work, owner: AcpRequestOwner, answer: ReturnType<typeof permissionResponse>): Promise<void> {
        if (this.disposed || !this.connection.alive) return;
        const current = this.current(owner);
        if (this.disposed || !this.connection.alive) return;
        const response = work.cancelled || !current
            ? { outcome: { outcome: 'cancelled' as const } } : answer;
        work.selectedReplyInFlight = response.outcome.outcome === 'selected';
        try { await this.connection.reply(work.id, response); }
        finally { work.selectedReplyInFlight = false; }
    }

    private async permission(work: Work, owner: AcpRequestOwner, params: ReturnType<typeof validatedPermissionParams>): Promise<void> {
        const cancelled = permissionResponse({ optionId: null }, params.options);
        const automatic = automaticPermission(this.permissions, params.options);
        if (automatic !== undefined || work.cancelled) {
            await this.reply(work, owner, automatic === undefined ? cancelled
                : permissionResponse({ optionId: automatic }, params.options));
            return;
        }
        const prepared = preparePermissionRequest(params.title, params.options);
        try {
            let pending;
            try {
                pending = this.registry.open({ ...owner.binding,
                    ...(owner.parentItemId === undefined ? {} : { parentItemId: owner.parentItemId }),
                    requestType: 'approval', view: prepared.view, validate: prepared.validate, cancelled,
                    isCurrent: () => !work.cancelled && this.current(owner) });
            } catch { await this.reply(work, owner, cancelled); return; }
            work.cancel = pending.cancel;
            try {
                if (!this.emit(owner, { kind: 'request', requestId: pending.requestId, requestType: 'approval', view: pending.view })) {
                    work.cancelled = true;
                    pending.cancel();
                }
                await this.reply(work, owner, await pending.answer);
            } finally { this.emit(owner, { kind: 'request-settled', requestId: pending.requestId }); }
        } finally { prepared.dispose(); }
    }
}
