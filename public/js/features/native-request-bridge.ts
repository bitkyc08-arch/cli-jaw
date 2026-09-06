import { parseActivityIdentity, type ActivityIdentity } from '../../../src/shared/presentation.js';
import { parseRuntimeEvent } from '../../../src/shared/runtime-event-parse.js';
import { parseRuntimeRequestNotice, RUNTIME_REQUEST_NOTICE_EVENT } from '../../../src/shared/runtime-request-notice.js';
import { state } from '../state.js';
import { withCurrentSessionQuery } from './session-hub.js';
import { mountNativeRequests, type NativeRequestHealth } from './native-requests.js';

interface BridgeOptions {
    host(): HTMLElement | null;
    refreshSnapshot(): Promise<void>;
}
type Panel = ReturnType<typeof mountNativeRequests>;

/** SSE health is not REST freshness. This bridge never submits responses. */
export function createNativeRequestBridge(options: BridgeOptions) {
    let health: NativeRequestHealth = 'unknown';
    let epoch = 0, snapshotGeneration = 0;
    let identity: ActivityIdentity | null = null;
    let identityPath = '';
    let panel: Panel | null = null;
    let recovery: HTMLElement | null = null;
    let queued = false;
    let manualRequest: { epoch: number; path: string; panel: Panel | null } | null = null;
    const snapshotPath = () => withCurrentSessionQuery('/api/orchestrate/snapshot');
    const same = (other: ActivityIdentity) => identity?.sessionId === other.sessionId && identity.scope === other.scope;

    function showRecovery(message: string): void {
        const host = options.host();
        if (!host || panel) return;
        if (!recovery) {
            const doc = host.ownerDocument;
            recovery = doc.createElement('section'); recovery.className = 'native-requests';
            recovery.setAttribute('aria-label', 'Live runtime requests');
            const status = doc.createElement('p'); status.className = 'native-request-status';
            status.setAttribute('role', 'status');
            const retry = doc.createElement('button'); retry.type = 'button'; retry.textContent = 'Refresh requests';
            retry.addEventListener('click', () => { void manualRefresh(); });
            recovery.append(status, retry);
            const input = [...host.children].find(child => child.classList.contains('chat-input-area'));
            host.insertBefore(recovery, input ?? null);
        }
        recovery.querySelector('p')!.textContent = message;
    }

    function forget(): void {
        panel?.dispose(); panel = null;
        identity = null; state.activityIdentity = null;
    }

    function scheduleRefresh(): void {
        if (queued || health !== 'healthy' || !panel || (manualRequest?.epoch === epoch
            && manualRequest.path === identityPath && (!manualRequest.panel || manualRequest.panel === panel))) return;
        queued = true;
        const ownEpoch = epoch;
        queueMicrotask(() => {
            queued = false;
            if (ownEpoch === epoch && health === 'healthy' && identityPath === snapshotPath()) void panel?.refresh('auto');
        });
    }

    async function manualRefresh(): Promise<void> {
        if (manualRequest?.epoch === epoch && manualRequest.path === snapshotPath() && manualRequest.panel === panel) return;
        const own = { epoch, path: snapshotPath(), panel }; manualRequest = own;
        try {
            if (!panel || identityPath !== snapshotPath()) await options.refreshSnapshot();
            if (own.epoch === epoch && own.path === snapshotPath() && identityPath === own.path
                && (!own.panel || own.panel === panel)) await panel?.refresh('manual');
        } catch {
            showRecovery('Request identity could not be loaded. Refresh requests to retry.');
        } finally { if (manualRequest === own) manualRequest = null; }
    }

    function changeHealth(next: NativeRequestHealth): void {
        health = next; ++epoch;
        panel?.setStreamHealth(next);
        showRecovery(next === 'healthy' ? 'Loading request identity.'
            : 'Live request updates unavailable. Refresh requests to check pending requests manually.');
    }

    return {
        channelChanged() { changeHealth('unknown'); },
        unavailable() { changeHealth('unavailable'); },
        sseOpened() { changeHealth('healthy'); },
        invalidateIdentity() {
            ++epoch; ++snapshotGeneration; forget();
            showRecovery('Request identity changed. Refresh requests to check this conversation.');
        },
        /** Guard the entire snapshot application, not just the new identity field. */
        beginSnapshot() {
            const path = snapshotPath();
            if (identityPath && identityPath !== path) forget();
            const ownEpoch = epoch, generation = ++snapshotGeneration;
            const isCurrent = () => ownEpoch === epoch && generation === snapshotGeneration && path === snapshotPath();
            return {
                path, isCurrent,
                accept(value: unknown) {
                    if (!isCurrent()) return;
                    const next = parseActivityIdentity(value);
                    if (!next) { forget(); showRecovery('Request identity unavailable. Refresh requests to retry.'); return; }
                    if (!same(next)) {
                        forget(); identity = next; identityPath = path;
                        const host = options.host();
                        if (host) {
                            recovery?.remove(); recovery = null;
                            panel = mountNativeRequests(host, next, { health, autoStart: false,
                                onRefresh: () => { void manualRefresh(); },
                                isCurrent: () => identity === next && identityPath === snapshotPath() });
                        }
                    }
                    state.activityIdentity = next;
                    scheduleRefresh();
                },
                fail() {
                    if (!isCurrent()) return;
                    forget(); showRecovery('Request identity could not be loaded. Refresh requests to retry.');
                },
            };
        },
        event(name: string, value: unknown) {
            if (health !== 'healthy' || !identity || identityPath !== snapshotPath()) return;
            const notice = name === RUNTIME_REQUEST_NOTICE_EVENT ? parseRuntimeRequestNotice(value) : null;
            const runtime = name === 'agent_runtime' ? parseRuntimeEvent(value) : null;
            if ((notice && same(notice)) || (runtime && same(runtime)
                && (runtime.kind === 'request' || runtime.kind === 'request-settled'))) scheduleRefresh();
        },
        dispose() {
            ++epoch; ++snapshotGeneration; forget(); recovery?.remove(); recovery = null;
        },
    };
}
