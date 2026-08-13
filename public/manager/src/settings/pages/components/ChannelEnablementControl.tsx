import { useCallback, useState } from 'react';
import type { DirtyStore } from '../../types';
import { ToggleField } from '../../fields';

export type MessengerChannel = 'telegram' | 'discord' | 'slack';

type MessagingBlock = {
    enabledChannels?: MessengerChannel[];
    homeChannel?: MessengerChannel;
};

type Props = {
    pageChannel: MessengerChannel;
    snapshot: { messaging?: MessagingBlock };
    enabledChannels: MessengerChannel[];
    homeChannel: MessengerChannel;
    setEnabledChannels: (next: MessengerChannel[]) => void;
    setHomeChannel: (next: MessengerChannel) => void;
    dirty: DirtyStore;
    idPrefix?: string;
};

export function ChannelEnablementControl({
    pageChannel,
    snapshot,
    enabledChannels,
    homeChannel,
    setEnabledChannels,
    setHomeChannel,
    dirty,
    idPrefix = 'channel',
}: Props) {
    const messaging = snapshot.messaging || {};
    const originalEnabled = Array.isArray(messaging.enabledChannels) ? messaging.enabledChannels : [];
    const originalHome = messaging.homeChannel || 'telegram';

    const setDirtyEnabled = useCallback((next: MessengerChannel[]) => {
        dirty.set('messaging.enabledChannels', {
            value: next,
            original: originalEnabled,
            valid: true,
        });
    }, [dirty, originalEnabled]);

    const setDirtyHome = useCallback((next: MessengerChannel) => {
        dirty.set('messaging.homeChannel', {
            value: next,
            original: originalHome,
            valid: true,
        });
    }, [dirty, originalHome]);

    const isEnabled = enabledChannels.includes(pageChannel);

    return (
        <>
            <ToggleField
                id={`${idPrefix}-enabled`}
                label={`Receive inbound messages on ${capitalize(pageChannel)}`}
                value={isEnabled}
                onChange={(next) => {
                    const nextSet = next
                        ? [...new Set([...enabledChannels, pageChannel])]
                        : enabledChannels.filter(c => c !== pageChannel);
                    setEnabledChannels(nextSet);
                    setDirtyEnabled(nextSet);
                    if (next && enabledChannels.length === 0) {
                        setHomeChannel(pageChannel);
                        setDirtyHome(pageChannel);
                    }
                }}
            />
            <fieldset className="settings-field">
                <legend className="settings-field-label">Home channel (fallback for proactive sends)</legend>
                <div className="settings-active-channel-options" role="radiogroup" aria-label="Home channel">
                    {(['telegram', 'discord', 'slack'] as const).map((ch) => (
                        <label key={ch} className="settings-radio">
                            <input
                                type="radio"
                                name={`${idPrefix}-homeChannel`}
                                checked={homeChannel === ch}
                                onChange={() => {
                                    setHomeChannel(ch);
                                    setDirtyHome(ch);
                                }}
                            />
                            <span>{capitalize(ch)}</span>
                        </label>
                    ))}
                </div>
            </fieldset>
        </>
    );
}

function capitalize(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
}
