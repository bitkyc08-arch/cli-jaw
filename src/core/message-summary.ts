const TITLE_MAX_CHARS = 64;

function stripKnownPrefixes(line: string): string {
    return line
        .replace(/^\[사용자가 파일을 보냈습니다:[^\]]+\]\s*/u, '')
        .replace(/^사용자 메시지:\s*/u, '')
        .replace(/^user message:\s*/iu, '')
        .replace(/^assistant:\s*/iu, '')
        .replace(/^user:\s*/iu, '')
        .trim();
}

function stripMarkdown(line: string): string {
    return line
        .replace(/^#{1,6}\s+/, '')
        .replace(/^[-*+]\s+/, '')
        .replace(/^>\s*/, '')
        .replace(/`{1,3}/g, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .trim();
}

function clipTitle(value: string): string {
    if (value.length <= TITLE_MAX_CHARS) return value;
    return `${value.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…`;
}

export function cleanDashboardActivityTitle(input: string): string {
    const lines = String(input || '')
        .replace(/\r/g, '')
        .split('\n')
        .map(line => stripMarkdown(stripKnownPrefixes(line)).replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .filter(line => !line.startsWith('[사용자가 파일을 보냈습니다:'))
        .filter(line => !/^```/.test(line));
    return lines[0] ? clipTitle(lines[0]) : '';
}

export function dashboardActivityTitleFromExcerpt(input: string | null): string | null {
    const title = cleanDashboardActivityTitle(input || '');
    return title || null;
}
