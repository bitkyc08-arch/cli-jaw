const TITLE_MAX_CHARS = 64;

/**
 * 첨부 프롬프트의 머리 블록. 파일/이미지/동영상 세 변형과 다중 헤더를 모두
 * 덮는다. 한 가지만 알면 나머지 변형에서 업로드 절대경로가 활동 제목으로
 * 새어나간다 (devlog 260806_slack_multifile_ingest/010 D-5).
 */
// 조사가 다르다: 파일"을" / 이미지"를" / 동영상"을".
const SENT_PREFIX = /^\[(?:사용자가 (?:파일을|이미지를|동영상을) 보냈습니다:[^\]]+|사용자가 파일 \d+개를 보냈습니다)\]\s*/u;
/** 다중 목록의 번호 줄(`1. [이미지] /path`)도 제목이 되면 안 된다. */
const NUMBERED_ENTRY = /^\d+\.\s+\[(?:이미지|동영상|파일)\]\s/u;

function stripKnownPrefixes(line: string): string {
    return line
        .replace(SENT_PREFIX, '')
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
        .filter(line => !SENT_PREFIX.test(line))
        .filter(line => !NUMBERED_ENTRY.test(line))
        .filter(line => !/^```/.test(line));
    return lines[0] ? clipTitle(lines[0]) : '';
}

export function dashboardActivityTitleFromExcerpt(input: string | null): string | null {
    const title = cleanDashboardActivityTitle(input || '');
    return title || null;
}
