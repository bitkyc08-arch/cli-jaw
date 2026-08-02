// Phase 3 — shared active-channel selector. Appears at the top of both
// the Telegram and Discord pages so the user can toggle the active
// channel without leaving the page they're configuring.
//
// Both pages write to the same `channel` dirty key. The dirty store
// dedupes by key, so cross-page collisions resolve to last-write-wins
// inside a single mount; the parent shell clears the store on category
// change so the two pages can never have conflicting pending values
// simultaneously.

import { useCallback, useState } from 'react';
import type { DirtyStore } from '../../types';

export type ActiveChannel = 'telegram' | 'discord' | 'slack';

const CHANNELS: ReadonlyArray<{ value: ActiveChannel; label: string }> = [
    { value: 'telegram', label: 'Telegram' },
    { value: 'discord', label: 'Discord' },
    { value: 'slack', label: 'Slack' },
];

type Props = {
    original: ActiveChannel | undefined;
    dirty: DirtyStore;
    /** Optional id prefix so two instances on one page (defensive) don't collide. */
    idPrefix?: string;
};

export function ActiveChannelToggle({ original, dirty, idPrefix = 'channel' }: Props) {
    const [value, setValue] = useState<ActiveChannel>(original ?? 'telegram');

    const onPick = useCallback(
        (next: ActiveChannel) => {
            setValue(next);
            dirty.set('channel', {
                value: next,
                original: original ?? 'telegram',
                valid: true,
            });
        },
        [dirty, original],
    );

    return (
        <fieldset
            className="settings-field settings-field-active-channel"
            aria-label="Active inbound channel"
        >
            <legend className="settings-field-label">Active inbound channel (chat replies)</legend>
            <div className="settings-active-channel-options" role="radiogroup">
                {CHANNELS.map((opt) => {
                    const id = `${idPrefix}-${opt.value}`;
                    const checked = value === opt.value;
                    return (
                        <label key={opt.value} htmlFor={id} className="settings-radio">
                            <input
                                id={id}
                                type="radio"
                                name={idPrefix}
                                value={opt.value}
                                checked={checked}
                                onChange={() => onPick(opt.value)}
                            />
                            <span>{opt.label}</span>
                        </label>
                    );
                })}
            </div>
        </fieldset>
    );
}
