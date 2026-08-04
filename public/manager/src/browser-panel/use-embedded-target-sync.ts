import { useEffect, useRef } from 'react';
import { getDesktop } from '../panels/desktop-bridge';

const PUSH_DEBOUNCE_MS = 400;
const REFRESH_INTERVAL_MS = 60_000;
const COMMAND_POLL_WAIT_MS = 25_000;
const COMMAND_POLL_ERROR_BACKOFF_MS = 3_000;

type SharedTargetPayload = {
    targetId: string;
    url: string;
    title: string;
    devToolsOpen: boolean;
    sharedWithAgent: true;
    actionsEnabled: boolean;
};

async function collectSharedTargets(): Promise<SharedTargetPayload[] | null> {
    const bridge = getDesktop()?.browser;
    if (!bridge?.getWebviewTabs) return null;
    const result = await bridge.getWebviewTabs();
    if (!result?.ok) return null;
    return (result.tabs ?? [])
        .filter(tab => tab.sharedWithAgent === true)
        .map(tab => ({
            targetId: tab.tabId,
            url: tab.url,
            title: tab.title,
            devToolsOpen: tab.devToolsOpen === true,
            sharedWithAgent: true as const,
            actionsEnabled: true,
        }));
}

/**
 * 030 v2/v2.1/v3 renderer relay.
 *
 * - v2: pushes agent-visible targets to the manager's read-only registry.
 * - v2.1: reconciles visible targets into the SELECTED instance's runtime-context
 *   (visibility = "send to the currently selected instance's agent"); switching
 *   instances cleans the previous instance up with an empty push.
 * - v3: long-polls the manager's command queue and executes screenshot
 *   commands via the Electron bridge, but only for still-visible targets.
 */
export function useEmbeddedBrowserTargetSync(active: boolean, selectedPort: number | null): void {
    const timerRef = useRef<number | null>(null);
    const lastInstancePortRef = useRef<number | null>(null);

    useEffect(() => {
        if (!active) return undefined;
        const bridge = getDesktop()?.browser;
        if (!bridge?.getWebviewTabs || !bridge.onWebviewState) return undefined;

        let disposed = false;
        const pollAbort = new AbortController();

        async function pushToInstance(port: number, targets: SharedTargetPayload[]): Promise<void> {
            try {
                await fetch(`/api/dashboard/instances/${port}/embedded-browser/targets`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ targets }),
                });
            } catch { /* instance may be offline; next push retries */ }
        }

        async function push(): Promise<void> {
            if (disposed) return;
            const targets = await collectSharedTargets().catch(() => null);
            if (disposed || targets === null) return;
            try {
                await fetch('/api/manager/embedded-browser/targets', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ targets }),
                });
            } catch { /* server may be restarting */ }
            if (disposed) return;
            const previousPort = lastInstancePortRef.current;
            if (previousPort !== null && previousPort !== selectedPort) {
                // Instance switch: withdraw shares from the previous instance.
                await pushToInstance(previousPort, []);
                if (disposed) return;
            }
            if (selectedPort !== null) {
                await pushToInstance(selectedPort, targets);
                if (disposed) return;
            }
            lastInstancePortRef.current = selectedPort;
        }

        function schedulePush(): void {
            if (timerRef.current !== null) window.clearTimeout(timerRef.current);
            timerRef.current = window.setTimeout(() => { void push(); }, PUSH_DEBOUNCE_MS);
        }

        async function executeCommand(command: { targetId: string; kind: string; act?: unknown }): Promise<Record<string, unknown>> {
            const browserBridge = getDesktop()?.browser;
            if (!browserBridge?.performWebviewAction) return { ok: false, error: 'bridge unavailable' };
            const shared = (await collectSharedTargets().catch(() => null)) ?? [];
            const target = shared.find(t => t.targetId === command.targetId);
            if (!target) return { ok: false, error: 'target is no longer available in Manager Browser' };
            const targetId = command.targetId;
            if (command.kind === 'screenshot') {
                const result = await browserBridge.performWebviewAction({ kind: 'captureScreenshot', tabId: targetId });
                if (result?.ok && result.screenshot) return { ok: true, screenshot: result.screenshot };
                return { ok: false, error: result?.error ?? 'capture failed' };
            }
            if (command.kind === 'snapshot') {
                const result = await browserBridge.performWebviewAction({ kind: 'getDomSnapshot', tabId: targetId });
                if (result?.ok && result.snapshot) return { ok: true, snapshot: result.snapshot };
                return { ok: false, error: result?.error ?? 'snapshot failed' };
            }
            if (command.kind === 'act') {
                const act = command.act as { kind: 'click' | 'type' | 'scroll' | 'key' } | undefined;
                if (!act) return { ok: false, error: 'act payload missing' };
                const result = await browserBridge.performWebviewAction({ kind: 'act', tabId: targetId, act: act as never });
                if (result?.ok) return { ok: true, acted: true };
                return { ok: false, error: result?.error ?? 'act failed' };
            }
            return { ok: false, error: `unknown command kind: ${command.kind}` };
        }

        async function pollCommands(): Promise<void> {
            while (!disposed) {
                const iterationStart = Date.now();
                try {
                    const response = await fetch(`/api/manager/embedded-browser/commands?wait=${COMMAND_POLL_WAIT_MS}`, { signal: pollAbort.signal });
                    // Older manager servers without this route answer instantly
                    // (404/HTML); treat anything non-OK as an error so the loop
                    // backs off instead of hammering the server.
                    if (!response.ok) throw new Error(`commands poll ${response.status}`);
                    const body = await response.json() as { commands?: Array<{ id: string; targetId: string; kind: string; act?: unknown; settleToken?: string }> };
                    for (const command of body.commands ?? []) {
                        if (disposed) return;
                        const result = await executeCommand(command);
                        await fetch(`/api/manager/embedded-browser/commands/${encodeURIComponent(command.id)}/result`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ ...result, settleToken: command.settleToken }),
                        }).catch(() => undefined);
                    }
                } catch {
                    await new Promise(resolve => setTimeout(resolve, COMMAND_POLL_ERROR_BACKOFF_MS));
                }
                // Hard floor: never iterate faster than once per second even if
                // the server answers empty results immediately.
                const elapsed = Date.now() - iterationStart;
                if (!disposed && elapsed < 1000) {
                    await new Promise(resolve => setTimeout(resolve, 1000 - elapsed));
                }
            }
        }

        const unsubscribe = bridge.onWebviewState(() => schedulePush());
        // D4: throttle the refresh while hidden rather than skipping it. This
        // push is what keeps `lastPushAt` fresh, and the server drops a target
        // from the registry after STALE_AFTER_MS (5 min,
        // src/manager/routes/embedded-browser.ts:54). Skipping outright would
        // 404 the agent's browser targets after five hidden minutes, while the
        // command long-poll kept delivering commands that then fail. Pushing at
        // a slower cadence keeps registration alive at a fraction of the cost.
        const HIDDEN_PUSH_INTERVAL_MS = 4 * 60 * 1000;
        let lastHiddenPush = 0;
        const interval = window.setInterval(() => {
            if (typeof document !== 'undefined' && document.hidden) {
                if (Date.now() - lastHiddenPush < HIDDEN_PUSH_INTERVAL_MS) return;
                lastHiddenPush = Date.now();
                void push();
                return;
            }
            lastHiddenPush = 0;
            void push();
        }, REFRESH_INTERVAL_MS);
        void push();
        void pollCommands();

        return () => {
            disposed = true;
            // Kill the in-flight 25s long-poll so a re-run (instance switch)
            // never has two concurrent poll loops.
            pollAbort.abort();
            unsubscribe();
            window.clearInterval(interval);
            if (timerRef.current !== null) window.clearTimeout(timerRef.current);
            // Withdraw targets from the instance this effect was serving;
            // otherwise targets linger in its runtime-context until the TTL.
            // On an effect re-run the next push() re-delivers to the new port.
            const port = lastInstancePortRef.current;
            lastInstancePortRef.current = null;
            if (port !== null) {
                void fetch(`/api/dashboard/instances/${port}/embedded-browser/targets`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ targets: [] }),
                }).catch(() => undefined);
            }
        };
    }, [active, selectedPort]);
}
