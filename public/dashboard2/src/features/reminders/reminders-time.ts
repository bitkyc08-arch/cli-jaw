export function dateScore(value: string | null | undefined): number {
    if (!value) return Number.MAX_SAFE_INTEGER;
    const score = Date.parse(value);
    return Number.isFinite(score) ? score : Number.MAX_SAFE_INTEGER;
}

export function relativeTime(value: string | null | undefined, now = Date.now()): string {
    const timestamp = dateScore(value);
    if (timestamp === Number.MAX_SAFE_INTEGER) return 'No due time';
    const delta = timestamp - now;
    const absolute = Math.abs(delta);
    if (absolute < 45_000) return 'now';
    const units: Array<[number, string]> = [
        [86_400_000, 'd'],
        [3_600_000, 'h'],
        [60_000, 'm'],
    ];
    const unit = units.find(([size]) => absolute >= size) ?? units[2]!;
    const amount = Math.max(1, Math.round(absolute / unit[0]));
    return delta > 0 ? `in ${amount}${unit[1]}` : `${amount}${unit[1]} ago`;
}

export function fullDate(value: string | null | undefined): string {
    const timestamp = dateScore(value);
    if (timestamp === Number.MAX_SAFE_INTEGER) return 'No due time';
    return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
    }).format(timestamp);
}
