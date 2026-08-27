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
import {
    settings,
    saveSettings,
    loadSettings,
    getServerUrl,
    configuredSlackEnvironmentVariables,
} from '../../src/core/config.js';
import { cliFetch, getCliAuthToken } from '../../src/cli/api-auth.js';
import { slackApi } from '../../src/slack/api.js';
import { slackManifestYaml, slackManifestCreateUrl } from '../../src/slack/manifest.js';
import { notifyRunningServer, type HotReload } from '../../src/slack/hot-notify.js';
import { getHomeChannel } from '../../src/messaging/runtime.js';
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
    manifest              Print the Slack app manifest YAML to stdout.
                          Pipe it: jaw slack manifest | pbcopy
    manifest --url        Print an app-creation URL with the manifest embedded.
                          Slack validates that URL parameter, not what you paste
                          into the editor, so this is the form that succeeds.
    setup                 Guided setup: prints the manifest, validates the two
                          tokens live, writes settings, hot-reloads the server.
    history <channel>     Read recent channel messages (or one thread) through
                          the running server. Flags: --thread <ts>, --limit N,
                          --json. The token never leaves the server process.
    members <channel>     List who is in a conversation, with resolved names.
                          Flags: --limit N, --json
    users                 List workspace users. Flags: --limit N, --json,
                          --include-bots, --include-deleted

  Setup flags:
    --bot-token <t>       Bot token (xoxb-...). REQUIRED.
                          Source: api.slack.com/apps → your app →
                          OAuth & Permissions → Install to Workspace →
                          Bot User OAuth Token
    --app-token <t>       App-level token (xapp-...). Optional; enables inbound
                          via Socket Mode. Omit for outbound-only.
                          Source: api.slack.com/apps → your app →
                          Basic Information → App-Level Tokens →
                          Generate Token (scope: connections:write)
    --team-id <id>        Slack team ID (auto-filled from auth.test when omitted)
    --channel-ids <ids>   Comma-separated conversation IDs (empty = all allowed)
    --non-interactive     Never prompt; requires --bot-token
    --skip-validate       Write settings WITHOUT live validation (offline; prints a warning)
    --no-notify           Do not hot-notify a running server (tests, offline)

  Non-interactive example (agent-safe — no prompts, no token echo):
    jaw slack setup --non-interactive \\
      --bot-token xoxb-... --app-token xapp-... --channel-ids C0123456789

  What setup writes/does:
    - settings.json: slack.enabled=true, botToken, appToken, teamId,
      channelIds, attachPort (the configuring instance's port — one bot,
      one instance; other instances sharing the tokens will not connect).
      File permissions are tightened to 0600.
    - Validates tokens first (auth.test, apps.connections.open) unless
      --skip-validate; nothing is written on validation failure.
    - Hot-notifies a running server via loopback PUT /api/settings, so the
      Slack socket opens WITHOUT a server restart (skipped by --no-notify,
      or when the server runs an older build — then it tells you to restart).

  Exit codes: 0 = success (or outbound-only with a warning),
              1 = missing/invalid/swapped token, or validation failure.

  Why not OAuth one-click? Slack app-level tokens (xapp-) are UI-only, and the
  PKCE localhost flow bans bot scopes — a browser click cannot configure a
  self-hosted Socket Mode bot. This wizard is the shortest honest path.
`);

const sub = process.argv[3] || 'setup';

const { values, positionals } = parseArgs({
    args: process.argv.slice(4),
    options: {
        'bot-token': { type: 'string' },
        'app-token': { type: 'string' },
        'team-id': { type: 'string' },
        'channel-ids': { type: 'string' },
        'non-interactive': { type: 'boolean', default: false },
        'skip-validate': { type: 'boolean', default: false },
        'no-notify': { type: 'boolean', default: false },
        // `history` subcommand flags. Sharing one parseArgs across
        // subcommands requires the union of options; allowPositionals
        // admits the <channel> argument (audit finding 1 — the strict
        // default would throw before the subcommand dispatch below).
        'thread': { type: 'string' },
        'limit': { type: 'string' },
        'json': { type: 'boolean', default: false },
        'include-bots': { type: 'boolean', default: false },
        'include-deleted': { type: 'boolean', default: false },
        // `manifest` subcommand flag.
        'url': { type: 'boolean', default: false },
    },
    allowPositionals: true,
});

if (sub === 'manifest') {
    // `--url` is the form that actually works in Slack's UI: the page validates the
    // manifest_json query parameter, not the editor contents (#396).
    process.stdout.write(values['url'] ? `${slackManifestCreateUrl()}\n` : slackManifestYaml());
} else if (sub === 'setup') {
    await runSetup();
} else if (sub === 'history') {
    await runHistory();
} else if (sub === 'members') {
    await runRoster('members');
} else if (sub === 'users') {
    await runRoster('users');
} else {
    console.error(`  ❌ Unknown slack subcommand "${sub}". Expected: manifest | setup | history | members | users`);
    process.exitCode = 1;
}

async function runSetup(): Promise<void> {
    // The module-level `settings` export is createDefaultSettings() until a
    // command explicitly loads the file — every settings-touching CLI command
    // (worker/task/memory/dispatch/…) does this. Without it the wizard would
    // "preserve" defaults over the user's real slack.mentionOnly etc.
    loadSettings();
    const environmentVariables = configuredSlackEnvironmentVariables();
    if (environmentVariables.length > 0) {
        console.error(`  ❌ Slack connection settings are managed by environment variables (${environmentVariables.join(', ')}). Remove them and restart before running jaw slack setup.`);
        process.exitCode = 1;
        return;
    }
    const nonInteractive = !!values['non-interactive'];
    const skipValidate = !!values['skip-validate'];

    // Prompting needs a terminal, not just the absence of --non-interactive.
    // Under a pipe or </dev/null, readline's question() never calls back — stdin
    // ends without a line — so the wizard stalls on a promise that can never
    // settle. That is not catchable: node reports "unsettled top-level await"
    // and exits 13 with the validated tokens still unwritten (#475). The fix is
    // to never create the interface when there is no TTY to answer it.
    const interactive = !nonInteractive && !!process.stdin.isTTY;
    const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
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

  Already installed from an older manifest? Sender names and member lookups need
  scopes an existing install does not have. Reinstall to pick them up:
    api.slack.com/apps -> your app -> OAuth & Permissions -> Reinstall to Workspace
  Until then senders show as raw ids and messaging is unaffected.

  Step 1 — create the app
    Open the URL below. It carries the manifest with it — do NOT paste into the
    editor at plain ?new_app=1: Slack validates the URL's manifest_json parameter,
    not the editor, so pasting leaves Create disabled with no error shown (#396).
`);
        console.log(`    ${slackManifestCreateUrl()}\n`);
        console.log('    Manifest, for reference:');
        console.log(slackManifestYaml().split('\n').map(l => `    ${l}`).join('\n'));

        // Best-effort conveniences: copy the manifest to the macOS clipboard
        // and open the app creation page. Failures are silent — the manifest
        // and URL are printed above regardless.
        // Gated on `interactive`, not just the flag: the Enter wait below is a
        // prompt like any other, and opening a browser is a courtesy aimed at a
        // person sitting at a terminal (#475).
        if (interactive) {
            if (process.platform === 'darwin') {
                const pbcopy = execFile('pbcopy', [], () => { });
                pbcopy.stdin?.end(slackManifestYaml());
                console.log('    (manifest copied to clipboard via pbcopy)');
                execFile('open', [slackManifestCreateUrl()], () => { });
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
        // The Slack UI shows app-level tokens in a narrow field, and a partial copy
        // out of it produces a well-formed prefix with a truncated body. That reaches
        // apps.connections.open as a plain `invalid_auth`, which reads as a wrong
        // token rather than a short one, and people re-generate instead of re-copying
        // (#396). A real xapp- token runs well past 50 characters.
        if (appToken && appToken.length < 50) {
            console.error(`  ❌ That app-level token is only ${appToken.length} characters — it looks truncated.`);
            console.error('     Slack\'s token field scrolls; use its Copy button rather than selecting the text.');
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
        // (mentionOnly, replyInThread, forwardAll, allowBots).
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
        // `slack.enabled` says the channel is configured; `enabledChannels` says
        // it should RUN. Both are required, and the wizard used to write only the
        // first — so a correct setup ended with the socket still closed and
        // `activeInbound` naming some other, disabled channel. Nothing in the
        // output said a step was left (#477).
        //
        // Only inbound-capable setups are enrolled. Without an app token there
        // is no socket to open, so adding it here would enable a transport that
        // cannot start and report a fault instead of "outbound only".
        //
        // `homeChannel` is deliberately NOT taken. It decides where UNADDRESSED
        // messages go, so moving it would silently redirect heartbeats and
        // reminders away from the channel the user already chose — the same
        // hijack the SLACK_BOT_TOKEN import refuses to do. It is only set when
        // nothing else is enabled, where there is no other channel to steal from.
        const enrolledSlack = Boolean(appToken);
        if (enrolledSlack) {
            const messaging = (s["messaging"] && typeof s["messaging"] === 'object' && !Array.isArray(s["messaging"]))
                ? s["messaging"] as Record<string, unknown>
                : {};
            const enabled = Array.isArray(messaging["enabledChannels"])
                ? messaging["enabledChannels"].filter((c): c is string => typeof c === 'string')
                : [];
            const others = enabled.filter(c => c !== 'slack');
            s["messaging"] = {
                ...messaging,
                enabledChannels: [...new Set([...enabled, 'slack'])],
                homeChannel: others.length ? messaging["homeChannel"] : 'slack',
            };
        }
        saveSettings(s);

        // A file write alone never starts the transport — hot-notify the
        // running server so the Slack socket opens now, not after a restart.
        const hotReload: HotReload = values['no-notify']
            ? 'server-off'
            : await notifyRunningServer(
                s["slack"] as Record<string, unknown>,
                undefined,
                enrolledSlack ? s["messaging"] as Record<string, unknown> : undefined,
            );
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
    Inbound     : ${enrolledSlack
        ? `enabled${getHomeChannel(s) === 'slack' ? ' (home channel)' : ''}`
        : 'off — no app token, so this instance can post but not receive'}

  Next steps:
    1. /invite @cli-jaw in each channel the bot should read
${serverLine}
    3. jaw doctor — confirm the Slack check is green
`);
    } finally {
        rl?.close();
    }
}

/**
 * Roster reads. Server-mediated like `history`: the CLI process never touches
 * the bot token — the running server owns credentials and the lookup routes.
 */
async function runRoster(kind: 'members' | 'users'): Promise<void> {
    loadSettings();
    const channel = (positionals[0] || '').trim();
    if (kind === 'members' && !channel) {
        console.error('Usage: jaw slack members <channel> [--limit N] [--json]');
        process.exitCode = 1;
        return;
    }
    const params = new URLSearchParams();
    if (kind === 'members') params.set('channel', channel);
    if (values['limit']) params.set('limit', String(values['limit']));
    if (values['include-bots']) params.set('include_bots', '1');
    if (values['include-deleted']) params.set('include_deleted', '1');
    if (!values['json']) params.set('format', 'text');
    const base = getServerUrl();
    await getCliAuthToken();
    try {
        const res = await cliFetch(`${base}/api/slack/${kind}?${params}`);
        const body = await res.json() as Record<string, unknown>;
        if (!res.ok || body['ok'] !== true) {
            console.error(String(body['error'] || `Failed: ${res.status}`));
            process.exitCode = 1;
            return;
        }
        if (values['json']) {
            console.log(JSON.stringify({
                members: body['members'], hasMore: body['hasMore'], partial: body['partial'],
            }, null, 2));
        } else {
            console.log(String(body['text'] || '(no members)'));
        }
    } catch {
        console.error('Server not running. Start with: jaw serve');
        process.exitCode = 1;
    }
}

async function runHistory(): Promise<void> {
    // Server-mediated on purpose: the CLI process never touches the bot
    // token — the running server owns credentials and the lookup route.
    loadSettings();
    const channel = (positionals[0] || '').trim();
    if (!channel) {
        console.error('Usage: jaw slack history <channel> [--thread <ts>] [--limit N] [--json]');
        process.exitCode = 1;
        return;
    }
    const base = getServerUrl();
    await getCliAuthToken();
    const params = new URLSearchParams({ channel });
    if (values['thread']) params.set('thread_ts', String(values['thread']));
    if (values['limit']) params.set('limit', String(values['limit']));
    if (!values['json']) params.set('format', 'text');
    try {
        const res = await cliFetch(`${base}/api/slack/history?${params}`);
        const body = await res.json() as Record<string, unknown>;
        if (!res.ok || body['ok'] !== true) {
            console.error(String(body['error'] || `Failed: ${res.status}`));
            process.exitCode = 1;
            return;
        }
        if (values['json']) {
            console.log(JSON.stringify({ messages: body['messages'], hasMore: body['hasMore'] }, null, 2));
        } else {
            console.log(String(body['text'] || '(no messages)'));
        }
    } catch {
        console.error('Server not running. Start with: jaw serve');
        process.exitCode = 1;
    }
}
