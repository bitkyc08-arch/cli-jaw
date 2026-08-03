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

export const SLACK_APP_MANIFEST = {
    _metadata: { major_version: 1 },
    display_information: {
        name: 'cli-jaw',
        description: 'AI agent orchestration — relay messages to your cli-jaw instance',
    },
    features: {
        bot_user: {
            display_name: 'cli-jaw',
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
            { command: '/status', description: 'cli-jaw status', usage_hint: '', should_escape: false },
            { command: '/model', description: 'Show or switch the model', usage_hint: '[model]', should_escape: false },
            { command: '/cli', description: 'Show or switch the CLI engine', usage_hint: '[engine]', should_escape: false },
            { command: '/clear', description: 'Clear the conversation', usage_hint: '', should_escape: false },
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
                //   chat:write          -> chat.postMessage
                //   files:write         -> files.getUploadURLExternal / completeUploadExternal
                //   commands            -> slash_commands envelopes
                'app_mentions:read',
                'channels:history',
                'groups:history',
                'im:history',
                'im:write',
                'chat:write',
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

/** Serialize the manifest for pasting into Slack's "From an app manifest" flow. */
export function slackManifestYaml(): string {
    return stringify(SLACK_APP_MANIFEST);
}
