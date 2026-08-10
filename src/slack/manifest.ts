// ─── Canonical Slack app manifest ────────────────────
// Single source of truth for "create the Slack app cli-jaw expects".
// The operator runbook (devlog 260802_slack_channel/051) shows the output of
// this file; tests/unit/slack-manifest.test.ts pins the shape so the two can
// never drift apart silently.
//
// Why not OAuth one-click: Slack cannot deliver this app's credentials
// through a browser click. App-level tokens (xapp-) are UI-only by design,
// and the PKCE localhost flow GA'd 2026-03-30 explicitly bans bot scopes on
// desktop redirects. Full analysis: devlog 260803_slack_oauth_setup/000.

import { stringify } from 'yaml';

export const DEFAULT_SLACK_APP_NAME = 'cli-jaw';
export const MAX_SLACK_APP_NAME_LENGTH = 35;

function normalizedSlackAppName(appName: string): string {
    const normalized = appName.trim();
    if (!normalized || Array.from(normalized).length > MAX_SLACK_APP_NAME_LENGTH || !/^[a-z0-9._-]+$/.test(normalized)) {
        throw new RangeError(`Slack app name must be 1-${MAX_SLACK_APP_NAME_LENGTH} characters using lowercase letters, numbers, dots, underscores, or hyphens.`);
    }
    return normalized;
}

export function createSlackAppManifest(appName: string = DEFAULT_SLACK_APP_NAME) {
    const name = normalizedSlackAppName(appName);
    return {
        _metadata: { major_version: 1 },
        display_information: {
            name,
            description: 'AI agent orchestration — relay messages to your cli-jaw instance',
        },
        features: {
            bot_user: {
                display_name: name,
                always_online: false,
            },
            // The Messages tab is what gives users a DM composer for the app.
            // Without it the im:history/im:write scopes are granted but nobody
            // can actually start a DM.
            app_home: {
                messages_tab_enabled: true,
                messages_tab_read_only_enabled: false,
            },
            // The `commands` scope AUTHORIZES slash commands; it does not create
            // any. cli-jaw routes the received command name through its shared
            // command catalog, so any catalog command works once registered here.
            // Starter set only — add more from `cli-jaw help` as needed.
            slash_commands: [
                { command: '/model', description: 'Show or switch the model', usage_hint: '[model]', should_escape: false },
                { command: '/cli', description: 'Show or switch the CLI engine', usage_hint: '[engine]', should_escape: false },
                { command: '/clear', description: 'Clear the conversation', should_escape: false },
                { command: '/help', description: 'Command list', usage_hint: '[command]', should_escape: false },
            ],
        },
        oauth_config: {
            scopes: {
                bot: [
                    // Every scope here maps to a call the transport really makes:
                    //   app_mentions:read   -> app_mention envelopes
                    //   channels:history    -> message.channels envelopes
                    //   groups:history      -> message.groups envelopes
                    //   im:history          -> message.im envelopes (DMs; NOT covered by app_mention)
                    //   im:write            -> conversations.open (DM a user id)
                    //   chat:write          -> chat.postMessage + chat.update/chat.delete
                    //                          (live progress status edits its own message)
                    //   files:write         -> files.getUploadURLExternal / completeUploadExternal
                    //   commands            -> slash_commands envelopes
                    'app_mentions:read',
                    'channels:history',
                    'groups:history',
                    'im:history',
                    'im:write',
                    'chat:write',
                    // files.info -> files:read; authenticated private downloads use
                    // the same bot token only after Slack-host and SSRF validation.
                    'files:read',
                    'files:write',
                    'commands',
                ],
            },
        },
        settings: {
            event_subscriptions: {
                bot_events: [
                    'app_mention',
                    'message.channels',
                    'message.groups',
                    'message.im',
                ],
            },
            socket_mode_enabled: true,
            org_deploy_enabled: false,
            is_hosted: false,
            token_rotation_enabled: false,
        },
    } as const;
}

export const SLACK_APP_MANIFEST = createSlackAppManifest();

/** Serialize the manifest for pasting into Slack's "From a manifest" flow. */
export function slackManifestYaml(appName: string = DEFAULT_SLACK_APP_NAME): string {
    return stringify(createSlackAppManifest(appName));
}

/** Serialize the manifest as formatted JSON for the onboarding copy action. */
export function slackManifestJson(appName: string = DEFAULT_SLACK_APP_NAME): string {
    return JSON.stringify(createSlackAppManifest(appName), null, 2);
}
