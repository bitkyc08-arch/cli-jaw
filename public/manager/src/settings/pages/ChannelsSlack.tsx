// Channels (Slack) page.
//
// Settings keys:
//   channel                   (shared across telegram + discord + slack pages)
//   slack.enabled
//   slack.botToken            (SecretField, masked, never logged)
//   slack.appToken            (SecretField, masked, never logged)
//   slack.teamId
//   slack.channelIds          (string[])
//   slack.forwardAll
//   slack.allowBots
//   slack.mentionOnly
//   slack.replyInThread

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SettingsPageProps, DirtyEntry } from '../types';
import { ToggleField, SecretField, ChipListField, TextField } from '../fields';
import {
    SettingsSection,
    PageError,
    PageLoading,
    PageOffline,
    usePageSnapshot,
} from './page-shell';
import { expandPatch } from './path-utils';
import { ActiveChannelToggle } from './components/ActiveChannelToggle';
import type { ActiveChannel } from './components/ActiveChannelToggle';
import { TransportStatusChips } from './components/TransportStatusChips';

type SlackBlock = {
    enabled?: boolean;
    botToken?: string;
    appToken?: string;
    teamId?: string;
    channelIds?: string[];
    forwardAll?: boolean;
    allowBots?: boolean;
    mentionOnly?: boolean;
    replyInThread?: boolean;
};

type SlackSnapshot = {
    channel?: ActiveChannel;
    slack?: SlackBlock;
    [key: string]: unknown;
};

const SLACK_KEYS = [
    'channel',
    'slack.enabled',
    'slack.botToken',
    'slack.appToken',
    'slack.teamId',
    'slack.channelIds',
    'slack.forwardAll',
    'slack.allowBots',
    'slack.mentionOnly',
    'slack.replyInThread',
] as const;

/**
 * Slack conversation ids are prefix-typed, not numeric snowflakes:
 * C (channel), G (group/MPIM), D (IM) followed by uppercase alphanumerics.
 * This is the Slack analogue of ChannelsDiscord's isValidSnowflake.
 */
export function isValidSlackConversationId(chip: string): boolean {
    if (!chip) return false;
    return /^[CGD][A-Z0-9]{6,20}$/.test(chip.trim().toUpperCase());
}

export default function ChannelsSlack({ port, client, dirty, registerSave }: SettingsPageProps) {
    const { state, refresh, setData } = usePageSnapshot<SlackSnapshot>(client, '/api/settings');

    const [enabled, setEnabled] = useState(false);
    const [botToken, setBotToken] = useState('');
    const [appToken, setAppToken] = useState('');
    const [teamId, setTeamId] = useState('');
    const [channelIds, setChannelIds] = useState<string[]>([]);
    const [forwardAll, setForwardAll] = useState(true);
    const [allowBots, setAllowBots] = useState(false);
    const [mentionOnly, setMentionOnly] = useState(true);
    const [replyInThread, setReplyInThread] = useState(true);

    const applySnapshot = useCallback((sc: SlackBlock) => {
        setEnabled(Boolean(sc.enabled));
        setBotToken('');
        setAppToken('');
        setTeamId(sc.teamId ?? '');
        setChannelIds(Array.isArray(sc.channelIds) ? [...sc.channelIds] : []);
        setForwardAll(sc.forwardAll !== false);
        setAllowBots(Boolean(sc.allowBots));
        // These two default TRUE for Slack, so a Boolean() read would show them
        // off on a fresh install while the backend behaves as on.
        setMentionOnly(sc.mentionOnly !== false);
        setReplyInThread(sc.replyInThread !== false);
    }, []);

    useEffect(() => {
        if (state.kind !== 'ready') return;
        applySnapshot(state.data.slack || {});
    }, [state, applySnapshot]);

    useEffect(() => {
        return () => {
            for (const key of SLACK_KEYS) dirty.remove(key);
        };
    }, [dirty]);

    const setEntry = useCallback(
        (key: string, entry: DirtyEntry) => dirty.set(key, entry),
        [dirty],
    );

    const original = useMemo<SlackBlock>(() => {
        if (state.kind !== 'ready') return {};
        return state.data.slack || {};
    }, [state]);

    const originalChannel = state.kind === 'ready' ? state.data.channel : undefined;

    const onSave = useCallback(async () => {
        const bundle = dirty.saveBundle();
        if (Object.keys(bundle).length === 0) return;
        const patch = expandPatch(bundle);
        const updated = await client.put<SlackSnapshot>('/api/settings', patch);
        const fresh = (updated && typeof updated === 'object' && 'data' in updated
            ? (updated as { data: SlackSnapshot }).data
            : updated) as SlackSnapshot;
        dirty.clear();
        setData(fresh);
        applySnapshot(fresh.slack || {});
        await refresh();
    }, [client, dirty, refresh, setData, applySnapshot]);

    useEffect(() => {
        if (!registerSave) return;
        registerSave(onSave);
        return () => registerSave(null);
    }, [registerSave, onSave]);

    if (state.kind === 'loading') return <PageLoading />;
    if (state.kind === 'offline') return <PageOffline port={port} />;
    if (state.kind === 'error') return <PageError message={state.message} />;

    const maskOf = (value: string | undefined) =>
        value ? `••••••••${value.slice(-4)}` : '(empty)';
    const invalidChannelIds = channelIds.filter((c) => !isValidSlackConversationId(c));
    const channelIdsError = invalidChannelIds.length > 0
        ? `Slack conversation IDs only (C…/G…/D…) — invalid: ${invalidChannelIds.join(', ')}`
        : null;
    const botTokenError = botToken && !botToken.startsWith('xoxb-')
        ? 'Bot tokens start with xoxb-.'
        : null;
    const appTokenError = appToken && !appToken.startsWith('xapp-')
        ? 'App-level tokens start with xapp-.'
        : null;
    // Surface the outbound-only state on THIS page rather than changing the
    // shared status chips, which are frozen for cross-channel changes.
    const outboundOnly = Boolean(original.enabled) && Boolean(original.botToken) && !original.appToken;
    const slackHint = outboundOnly
        ? 'Currently OUTBOUND-ONLY: the app-level token (xapp-) is missing, so no inbound Slack events can arrive.'
        : 'Slack needs TWO tokens: a bot token (xoxb-) for the Web API and an app-level token (xapp-) for Socket Mode.';

    return (
        <form
            className="settings-page-form"
            onSubmit={(event) => {
                event.preventDefault();
                void onSave();
            }}
        >
            <SettingsSection
                title="Channels"
                hint="Choose which channel receives inbound chat. Outbound send can still work on the other channels when configured."
            >
                <ActiveChannelToggle
                    original={originalChannel}
                    dirty={dirty}
                    idPrefix="sl-channel"
                />
                <TransportStatusChips client={client} channel="slack" />
            </SettingsSection>

            <SettingsSection
                title="Slack"
                hint={slackHint}
            >
                <ToggleField
                    id="sl-enabled"
                    label="Slack enabled"
                    value={enabled}
                    onChange={(next) => {
                        setEnabled(next);
                        setEntry('slack.enabled', {
                            value: next,
                            original: Boolean(original.enabled),
                            valid: true,
                        });
                    }}
                />
                <SecretField
                    id="sl-botToken"
                    label="Bot token"
                    value={botToken}
                    placeholder={maskOf(original.botToken)}
                    error={botTokenError}
                    onChange={(next) => {
                        setBotToken(next);
                        if (next.length === 0) {
                            dirty.remove('slack.botToken');
                            return;
                        }
                        setEntry('slack.botToken', {
                            value: next,
                            original: original.botToken ?? '',
                            valid: next.startsWith('xoxb-'),
                        });
                    }}
                />
                <SecretField
                    id="sl-appToken"
                    label="App-level token"
                    value={appToken}
                    placeholder={maskOf(original.appToken)}
                    error={appTokenError}
                    onChange={(next) => {
                        setAppToken(next);
                        if (next.length === 0) {
                            dirty.remove('slack.appToken');
                            return;
                        }
                        setEntry('slack.appToken', {
                            value: next,
                            original: original.appToken ?? '',
                            valid: next.startsWith('xapp-'),
                        });
                    }}
                />
                <TextField
                    id="sl-teamId"
                    label="Team ID"
                    value={teamId}
                    placeholder="T01234567 (optional)"
                    onChange={(next) => {
                        setTeamId(next);
                        setEntry('slack.teamId', {
                            value: next,
                            original: original.teamId ?? '',
                            valid: true,
                        });
                    }}
                />
                <ChipListField
                    id="sl-channelIds"
                    label="Channel IDs"
                    value={channelIds}
                    placeholder="C01234567"
                    error={channelIdsError}
                    onChange={(next) => {
                        setChannelIds(next);
                        setEntry('slack.channelIds', {
                            value: next,
                            original: original.channelIds ?? [],
                            valid: next.every(isValidSlackConversationId),
                        });
                    }}
                />
                <ToggleField
                    id="sl-mentionOnly"
                    label="Mention only"
                    value={mentionOnly}
                    onChange={(next) => {
                        setMentionOnly(next);
                        setEntry('slack.mentionOnly', {
                            value: next,
                            original: original.mentionOnly !== false,
                            valid: true,
                        });
                    }}
                />
                <ToggleField
                    id="sl-replyInThread"
                    label="Reply in thread"
                    value={replyInThread}
                    onChange={(next) => {
                        setReplyInThread(next);
                        setEntry('slack.replyInThread', {
                            value: next,
                            original: original.replyInThread !== false,
                            valid: true,
                        });
                    }}
                />
                <ToggleField
                    id="sl-forwardAll"
                    label="Forward all"
                    value={forwardAll}
                    onChange={(next) => {
                        setForwardAll(next);
                        setEntry('slack.forwardAll', {
                            value: next,
                            original: original.forwardAll !== false,
                            valid: true,
                        });
                    }}
                />
                <ToggleField
                    id="sl-allowBots"
                    label="Allow bots"
                    value={allowBots}
                    onChange={(next) => {
                        setAllowBots(next);
                        setEntry('slack.allowBots', {
                            value: next,
                            original: Boolean(original.allowBots),
                            valid: true,
                        });
                    }}
                />
            </SettingsSection>
        </form>
    );
}
