import { createHash } from 'node:crypto';
import { activityEntryLabel, activityEntryText, type ActivityEntry } from '../../shared/activity-state.js';
import type { ActivityTranscriptItem } from './activity.js';
import { safeActivityTerminalText } from './activity-terminal-text.js';

const fingerprint = (text: string): string => createHash('sha256').update(text).digest('hex');

export function closeActivityLinear(item: ActivityTranscriptItem): string {
    if (!item.lineActiveItemId) return '';
    item.lineActiveItemId = null;
    return '\n';
}

/** Native terminal autowrap owns streaming columns. Only newly visible safe text
 * is appended; a non-prefix replacement starts an explicitly updated snapshot. */
export function activityLinearDelta(item: ActivityTranscriptItem, entry: ActivityEntry): string {
    const text = safeActivityTerminalText(activityEntryText(entry));
    const label = safeActivityTerminalText(activityEntryLabel(entry));
    const previous = item.lineReceipts.get(entry.itemId);
    const prefix = Boolean(previous && previous.chars <= text.length
        && fingerprint(text.slice(0, previous.chars)) === previous.hash);
    const suffix = prefix ? text.slice(previous!.chars) : text;
    const heading = !previous || !prefix || previous.label !== label || item.lineActiveItemId !== entry.itemId;
    const output = (heading ? `\n${label}${previous && !prefix ? ' (updated)' : ''}\n` : '') + suffix;
    item.lineReceipts.set(entry.itemId, { chars: text.length, hash: fingerprint(text), label });
    for (const key of item.lineReceipts.keys()) if (!item.model.entries.has(key)) item.lineReceipts.delete(key);
    item.lineActiveItemId = entry.itemId;
    return output;
}
