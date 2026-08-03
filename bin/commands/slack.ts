/**
 * cli-jaw slack — Slack app manifest + guided setup.
 *
 * Why a wizard instead of OAuth one-click: Slack cannot deliver this app's
 * credentials through a browser click. App-level tokens (xapp-) are created
 * only in the app settings UI, and the PKCE localhost flow (GA 2026-03-30)
 * bans bot scopes on desktop redirects. So the fastest honest flow is:
 * paste the manifest, paste two tokens, let the wizard validate them live.
 * Full analysis: devlog 260803_slack_oauth_setup/000_research.md.
 */
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
import { settings, saveSettings, loadSettings } from '../../src/core/config.js';
import { slackApi } from '../../src/slack/api.js';
import { slackManifestYaml } from '../../src/slack/manifest.js';
import { notifyRunningServer, type HotReload } from '../../src/slack/hot-notify.js';
import { shouldShowHelp, printAndExit } from '../helpers/help.js';

// Mirror of the Slack settings shape (see doctor.ts): unlike the other
// channels, Slack has TWO distinctly-scoped tokens, so it cannot share the
// single-token MessagingSettings interface. Index signature keeps the merge
// non-destructive for fields this wizard does not own.
interface SlackSettings {
    enabled?: boolean;
    botToken?: string;
    appToken?: string;
    teamId?: string;
    channelIds?: string[];
    attachPort?: string;
    [key: string]: unknown;
}

if (shouldShowHelp(process.argv)) printAndExit(`
  jaw slack — Slack app manifest + guided setup

  Usage: jaw slack <subcommand> [flags]

  Subcommands:
    manifest              Print the Slack app manifest (paste into api.slack.com/apps → From an app manifest)
    setup                 Guided setup: manifest, live token validation, settings write

  Setup flags:
    --bot-token <t>       Bot token (xoxb-...)
    --app-token <t>       App-level token (xapp-..., enables inbound via Socket Mode)
    --team-id <id>        Slack team ID (auto-filled from auth.test when omitted)
    --channel-ids <ids>   Comma-separated conversation IDs (empty = all allowed)
    --non-interactive     Never prompt; requires --bot-token
    --skip-validate       Write settings WITHOUT live validation (offline; prints a warning)
    --no-notify           Do not hot-notify a running server (tests, offline)

  Why not OAuth one-click? Slack app-level tokens (xapp-) are UI-only, and the
  PKCE localhost flow bans bot scopes — a browser click cannot configure a
  self-hosted Socket Mode bot. This wizard is the shortest honest path.
`);

const sub = process.argv[3] || 'setup';

const { values } = parseArgs({
    args: process.argv.slice(4),
    options: {
        'bot-token': { type: 'string' },
        'app-token': { type: 'string' },
        'team-id': { type: 'string' },
        'channel-ids': { type: 'string' },
        'non-interactive': { type: 'boolean', default: false },
        'skip-validate': { type: 'boolean', default: false },
        'no-notify': { type: 'boolean', default: false },
    },
});

if (sub === 'manifest') {
    process.stdout.write(slackManifestYaml());
} else if (sub === 'setup') {
    await runSetup();
} else {
    console.error(`  ❌ Unknown slack subcommand "${sub}". Expected: manifest | setup`);
    process.exitCode = 1;
}

async function runSetup(): Promise<void> {
    // The module-level `settings` export is createDefaultSettings() until a
    // command explicitly loads the file — every settings-touching CLI command
    // (worker/task/memory/dispatch/…) does this. Without it the wizard would
    // "preserve" defaults over the user's real slack.mentionOnly etc.
    loadSettings();
    const nonInteractive = !!values['non-interactive'];
    const skipValidate = !!values['skip-validate'];

    const rl = nonInteractive ? null : createInterface({ input: process.stdin, output: process.stdout });
    const ask = (question: string, defaultVal = ''): Promise<string> => {
        if (!rl) return Promise.resolve(defaultVal);
        return new Promise(r => rl.question(`  ${question} `, (ans) => r(ans.trim() || defaultVal)));
    };

    try {
        const s = settings as Record<string, unknown>;
        const existing = (s["slack"] ?? {}) as SlackSettings;

        console.log(`
  🦈 jaw slack setup — attach a Slack workspace to this cli-jaw instance

  Slack cannot do OAuth one-click for a self-hosted Socket Mode bot:
  the app-level token (xapp-) is created only in the app settings UI, and the
  PKCE localhost flow bans bot scopes. So: paste a manifest, paste two tokens,
  and this wizard validates them live.

  Step 1 — create the app
    Open  https://api.slack.com/apps?new_app=1
    Choose "From an app manifest", pick your workspace, paste this:
`);
        console.log(slackManifestYaml().split('\n').map(l => `    ${l}`).join('\n'));

        // Best-effort conveniences: copy the manifest to the macOS clipboard
        // and open the app creation page. Failures are silent — the manifest
        // and URL are printed above regardless.
        if (!nonInteractive) {
            if (process.platform === 'darwin') {
                const pbcopy = execFile('pbcopy', [], () => { });
                pbcopy.stdin?.end(slackManifestYaml());
                console.log('    (manifest copied to clipboard via pbcopy)');
                execFile('open', ['https://api.slack.com/apps?new_app=1'], () => { });
            }
            await ask('Press Enter once the app is created and installed to the workspace…');
        }

        // Step 2 — bot token
        console.log('\n  Step 2 — bot token (OAuth & Permissions → Install to Workspace → xoxb-…)');
        let botToken = values['bot-token'] || await ask('Bot token (xoxb-...)', existing.botToken || '');
        if (!botToken) {
            console.error('  ❌ A bot token is required. Re-run when you have it, or use: jaw slack setup --bot-token xoxb-...');
            process.exitCode = 1;
            return;
        }
        // Same swap guard as `jaw init`: catch the classic xoxb/xapp mix-up
        // BEFORE writing, so the mistake cannot hide until server start.
        if (!botToken.startsWith('xoxb-')) {
            console.error(`  ❌ Slack bot token should start with "xoxb-" (got "${botToken.slice(0, 5)}…"). Did you swap it with the app-level token?`);
            process.exitCode = 1;
            return;
        }

        let teamId = values['team-id'] || '';
        if (!skipValidate) {
            const check = await slackApi<{ user_id?: string; team_id?: string }>(botToken, 'auth.test');
            if (!check.ok) {
                console.error(`  ❌ auth.test failed: ${check.error}. Token not written — fix it and re-run.`);
                process.exitCode = 1;
                return;
            }
            teamId = teamId || check.data?.team_id || '';
            console.log(`    ✅ auth.test ok${teamId ? ` (team ${teamId})` : ''}`);
        } else {
            console.warn('  ⚠️  --skip-validate: writing tokens WITHOUT live validation. Run jaw doctor after the server starts.');
        }

        // Step 3 — app-level token (optional; absence means outbound-only)
        console.log('\n  Step 3 — app-level token (Basic Information → App-Level Tokens, scope connections:write → xapp-…)');
        console.log('            Empty = outbound-only (posting works, no inbound events).');
        const appToken = values['app-token'] ?? await ask('App-level token (xapp-..., Enter to skip)', existing.appToken || '');
        if (appToken && !appToken.startsWith('xapp-')) {
            console.error(`  ❌ Slack app-level token should start with "xapp-" (got "${appToken.slice(0, 5)}…"). Did you swap it with the bot token?`);
            process.exitCode = 1;
            return;
        }
        if (appToken && !skipValidate) {
            // apps.connections.open doubles as the token's live check; the
            // returned wss URL is discarded — the server opens its own socket.
            const check = await slackApi(appToken, 'apps.connections.open');
            if (!check.ok) {
                console.error(`  ❌ apps.connections.open failed: ${check.error}. Token not written — fix it and re-run.`);
                process.exitCode = 1;
                return;
            }
            console.log('    ✅ apps.connections.open ok (Socket Mode reachable)');
        }
        if (!appToken) {
            console.warn('  ⚠️  Slack app-level token missing — outbound only, no inbound events.');
        }

        // Step 4 — channel IDs
        const channelIdsRaw = values['channel-ids'] ?? await ask('Channel IDs to allow (comma-separated, Enter = all)', (existing.channelIds || []).join(','));
        const channelIds = channelIdsRaw.split(',').map(s => s.trim()).filter(Boolean);

        // Merge: preserve every slack field the wizard does not own
        // (mentionOnly, replyInThread, forwardAll, allowBots) and never touch
        // `channel` — a two-token channel must not hijack the active channel
        // by accident, same rule as the SLACK_BOT_TOKEN env import.
        s["slack"] = {
            ...existing,
            enabled: true,
            botToken,
            appToken,
            teamId: teamId || existing.teamId || '',
            channelIds,
            // One bot, one instance: the instance configured here owns the
            // connection. Clones sharing these tokens will not open a socket.
            attachPort: String((s["port"] as string) || existing.attachPort || '3457'),
        } satisfies SlackSettings;
        saveSettings(s);

        // A file write alone never starts the transport — hot-notify the
        // running server so the Slack socket opens now, not after a restart.
        const hotReload: HotReload = values['no-notify']
            ? 'server-off'
            : await notifyRunningServer(s["slack"] as Record<string, unknown>);
        const serverLine =
            hotReload === 'reloaded' ? '    2. (done) the running server picked up the settings — no restart needed' :
            hotReload === 'old-server' ? `    2. Restart the server — it is running an OLDER build without the new Slack code (jaw serve)` :
            hotReload === 'server-off' ? '    2. Start the server (jaw serve) — settings apply on boot' :
            '    2. Restart the server if it is running (jaw serve)';

        console.log(`
  ✅ Slack settings saved.

    Bot token   : ${botToken.slice(0, 10)}…
    App token   : ${appToken ? appToken.slice(0, 10) + '…' : '(outbound only)'}
    Team        : ${(s["slack"] as SlackSettings).teamId || '(unknown)'}
    Channels    : ${channelIds.length ? channelIds.join(', ') : 'all conversations allowed'}

  Next steps:
    1. /invite @cli-jaw in each channel the bot should read
${serverLine}
    3. jaw doctor — confirm the Slack check is green
`);
    } finally {
        rl?.close();
    }
}
