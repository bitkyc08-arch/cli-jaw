// ─── Hot-reload the running server after CLI settings writes ──
// A settings FILE write alone never starts the Slack transport: the file
// watcher only refreshes memory values. The transport restart lives behind
// `PUT /api/settings` → applyRuntimeSettingsPatch → restartMessagingRuntime,
// and requireAuth bypasses auth for loopback — so a local CLI can hot-notify
// the running server instead of telling the user to restart it.
// Kept separate from bin/commands/slack.ts (which executes on import) so the
// behavior is unit-testable with an injected fetch.
import { getServerUrl, APP_VERSION } from '../core/config.js';

export type HotReload = 'reloaded' | 'server-off' | 'needs-restart' | 'old-server';

export async function notifyRunningServer(
    slackBlock: Record<string, unknown>,
    fetchImpl: typeof fetch = fetch,
): Promise<HotReload> {
    const base = getServerUrl();
    try {
        const health = await fetchImpl(`${base}/api/health`, { signal: AbortSignal.timeout(3000) });
        if (!health.ok) return 'needs-restart';
        const body = await health.json() as { version?: string };
        // A pre-Slack build has no transport to restart; merging settings
        // into it would LOOK applied while the socket never opens.
        if (body.version && body.version !== APP_VERSION) return 'old-server';
        const put = await fetchImpl(`${base}/api/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slack: slackBlock }),
            signal: AbortSignal.timeout(5000),
        });
        return put.ok ? 'reloaded' : 'needs-restart';
    } catch {
        return 'server-off';
    }
}
