import type { ManagerEvent } from './types';

export function isUnreadActivityEvent(event: ManagerEvent): boolean {
    return event.kind === 'instance-message' && event.role === 'assistant';
}

export function activityEventDedupeKey(event: ManagerEvent): string {
    if (event.kind === 'instance-message') return [event.kind, event.port, event.messageId].join('|');
    const port = 'port' in event ? String(event.port) : '';
    const message = 'message' in event
        ? event.message
        : 'reason' in event && typeof event.reason === 'string'
            ? event.reason
            : '';
    return [event.kind, port, event.at, message].join('|');
}

export function latestManagerEventAt(events: ManagerEvent[]): string | null {
    return events.reduce<string | null>((latest, event) => {
        if (!latest) return event.at;
        return Date.parse(event.at) > Date.parse(latest) ? event.at : latest;
    }, null);
}

export function latestManagerEventAtForPort(events: ManagerEvent[], port: number): string | null {
    return latestManagerEventAt(events.filter(event => 'port' in event && event.port === port));
}

export function countUnreadActivityEvents(events: ManagerEvent[], seenAt: string | null): number {
    const seen = new Set<string>();
    let count = 0;
    for (const event of events) {
        if (!isUnreadActivityEvent(event)) continue;
        if (seenAt && Date.parse(event.at) <= Date.parse(seenAt)) continue;
        const key = activityEventDedupeKey(event);
        if (seen.has(key)) continue;
        seen.add(key);
        count += 1;
    }
    return count;
}

function effectiveSeenAt(globalSeenAt: string | null, portSeenAt: string | null): string | null {
    if (!globalSeenAt) return portSeenAt;
    if (!portSeenAt) return globalSeenAt;
    return Date.parse(globalSeenAt) > Date.parse(portSeenAt) ? globalSeenAt : portSeenAt;
}

export function countUnreadActivityEventsByPort(
    events: ManagerEvent[],
    seenAt: string | null,
    seenByPort: Record<number, string> = {},
): Record<number, number> {
    const seen = new Set<string>();
    const counts: Record<number, number> = {};
    for (const event of events) {
        if (!('port' in event)) continue;
        if (!isUnreadActivityEvent(event)) continue;
        const portSeenAt = effectiveSeenAt(seenAt, seenByPort[event.port] || null);
        if (portSeenAt && Date.parse(event.at) <= Date.parse(portSeenAt)) continue;
        const key = activityEventDedupeKey(event);
        if (seen.has(key)) continue;
        seen.add(key);
        counts[event.port] = (counts[event.port] || 0) + 1;
    }
    return counts;
}
