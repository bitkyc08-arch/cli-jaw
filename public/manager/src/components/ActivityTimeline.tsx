/* 10.6.10 — Inbox-style grouped activity timeline.
 *
 * Accepts a flat list of entries and groups them into time buckets:
 *   Now           → last 5 minutes
 *   Earlier today → today, older than 5 minutes
 *   Yesterday     → calendar yesterday
 *   Older         → everything else
 *
 * The 10.7 phase will introduce a typed ManagerEvent stream. This component
 * accepts both that future shape and a simple string[] fallback so we can ship
 * the visual surface today without waiting on the backend.
 */

import { useMemo } from 'react';
import type { ManagerEvent } from '../types';

export type ActivityEntry = {
    at: string;            // ISO timestamp; missing → treated as Older
    source?: string;       // e.g. 'scan', 'lifecycle', 'registry'
    message: string;
};

type ActivityTimelineProps = {
    entries: Array<ActivityEntry | ManagerEvent | string>;
    emptyMessage?: string;
};

function eventToEntry(event: ManagerEvent): ActivityEntry {
    switch (event.kind) {
        case 'scan-completed':
            return { at: event.at, source: 'scan', message: `range ${event.from}-${event.to}, ${event.reachable} reachable` };
        case 'scan-failed':
            return { at: event.at, source: 'error', message: event.reason };
        case 'lifecycle-result':
            return { at: event.at, source: event.action, message: `:${event.port} ${event.status}` };
        case 'health-changed':
            return { at: event.at, source: 'health', message: `:${event.port} ${event.from} → ${event.to}` };
        case 'version-mismatch':
            return { at: event.at, source: 'version', message: `:${event.port} ${event.expected || '?'} → ${event.seen}` };
        case 'port-collision':
            return { at: event.at, source: 'collision', message: `:${event.port} pids ${event.pids.join(', ')}` };
        default:
            return { at: new Date().toISOString(), source: 'event', message: 'unknown event' };
    }
}

type Bucket = 'now' | 'earlier' | 'yesterday' | 'older';

const BUCKET_LABELS: Record<Bucket, string> = {
    now: 'Now',
    earlier: 'Earlier today',
    yesterday: 'Yesterday',
    older: 'Older',
};

const BUCKET_ORDER: Bucket[] = ['now', 'earlier', 'yesterday', 'older'];
const FIVE_MINUTES_MS = 5 * 60 * 1000;

function normalize(entry: ActivityEntry | ManagerEvent | string, fallbackAt: string): ActivityEntry {
    if (typeof entry === 'string') {
        return { at: fallbackAt, message: entry };
    }
    if ('kind' in entry) {
        return eventToEntry(entry);
    }
    return entry;
}

function bucketFor(at: string, now: Date): Bucket {
    const ts = Date.parse(at);
    if (Number.isNaN(ts)) return 'older';
    const diff = now.getTime() - ts;
    if (diff <= FIVE_MINUTES_MS) return 'now';
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    if (ts >= today.getTime()) return 'earlier';
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (ts >= yesterday.getTime()) return 'yesterday';
    return 'older';
}

function formatTime(at: string, bucket: Bucket): string {
    const date = new Date(at);
    if (Number.isNaN(date.getTime())) return '—';
    if (bucket === 'now' || bucket === 'earlier') {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    if (bucket === 'yesterday') {
        return `Yesterday ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function ActivityTimeline(props: ActivityTimelineProps) {
    const grouped = useMemo(() => {
        const now = new Date();
        const fallbackAt = now.toISOString();
        const groups: Record<Bucket, Array<ActivityEntry & { _bucket: Bucket }>> = {
            now: [], earlier: [], yesterday: [], older: [],
        };
        for (const raw of props.entries) {
            const entry = normalize(raw, fallbackAt);
            const bucket = bucketFor(entry.at, now);
            groups[bucket].push({ ...entry, _bucket: bucket });
        }
        return groups;
    }, [props.entries]);

    const total = props.entries.length;

    if (total === 0) {
        return (
            <div className="activity-list activity-list-empty" role="status">
                <p>{props.emptyMessage || 'Activity will appear here as scans, lifecycle changes, and registry updates happen.'}</p>
            </div>
        );
    }

    return (
        <div className="activity-list" role="list" aria-label="Recent activity grouped by time">
            {BUCKET_ORDER.map(bucket => {
                const items = grouped[bucket];
                if (items.length === 0) return null;
                return (
                    <section key={bucket} className="activity-group" aria-label={BUCKET_LABELS[bucket]}>
                        <header className="activity-group-header">{BUCKET_LABELS[bucket]}</header>
                        {items.map((item, index) => (
                            <article key={`${bucket}-${index}`} className="activity-entry" role="listitem">
                                <time className="activity-entry-time" dateTime={item.at}>
                                    {formatTime(item.at, item._bucket)}
                                </time>
                                {item.source && <span className="activity-entry-source">{item.source}</span>}
                                <p className="activity-entry-message">{item.message}</p>
                            </article>
                        ))}
                    </section>
                );
            })}
        </div>
    );
}
