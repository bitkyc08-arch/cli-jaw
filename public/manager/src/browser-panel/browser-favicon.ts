export function pickFaviconUrl(favicons: string[] | undefined): string | null {
    const first = favicons?.find(item => typeof item === 'string' && item.trim().length > 0);
    return first ? first.trim() : null;
}

function hostnameOf(url: string): string {
    try {
        return new URL(url).hostname;
    } catch {
        return url;
    }
}

export function faviconInitial(title: string, url: string): string {
    const source = title.trim() || hostnameOf(url);
    const ch = source.replace(/^www\./, '').charAt(0);
    return (ch || '?').toUpperCase();
}
