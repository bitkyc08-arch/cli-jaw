/**
 * Deep Research report-selection helpers. Pure functions ported from agbrowse
 * web-ai/chatgpt-deep-research-report.mjs (parity catalog 106.1) so the deep-research
 * poll loop can reject planning/progress/incomplete text instead of persisting a
 * normal reply or a planning card as a completed "report".
 */

export interface DeepResearchReportRead {
    text: string;
    sources: string[];
    from: string;
    completed: boolean;
}

interface RawReportRead {
    text?: string;
    sources?: string[];
    from?: string;
}

// First-line markers of a planning card / progress / status update — NOT a
// completed Deep Research report. Matched against the normalized first line.
const DR_INCOMPLETE_MARKERS: RegExp[] = [
    /^(researching|reading|searching|browsing|analy[sz]ing|gathering)\b/i,
    /^(thinking|working on it|in progress|please wait)\b/i,
    /^starting (deep )?research/i,
    /^i'?ll (research|look into|start|begin|investigate)/i,
    /^let me (research|look|dig|investigate)/i,
    /^here'?s my (research )?plan/i,
    /^research plan\b/i,
    /^(planning|plan:)\b/i,
    /^researched \d+ sources?$/i,
];

const DR_MIN_REPORT_CHARS = 120;

/** Normalize Deep Research report text: CRLF→LF, collapse 3+ blank lines, trim. */
export function normalizeDeepResearchReportText(text: unknown): string {
    if (typeof text !== 'string') return '';
    return text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * True if the text is an incomplete Deep Research artifact — a planning card,
 * progress/status line, or too short to be a final report. A completed report is
 * long-form and does not lead with a status marker.
 */
export function isIncompleteDeepResearchText(text: unknown): boolean {
    const norm = normalizeDeepResearchReportText(text);
    if (norm.length < DR_MIN_REPORT_CHARS) return true;
    const firstLine = (norm.split('\n', 1)[0] ?? '').trim();
    return DR_INCOMPLETE_MARKERS.some((re) => re.test(firstLine));
}

/**
 * Choose the authoritative Deep Research report between a page-scoped target read
 * and a legacy frame read. Prefers a COMPLETED target over a frame; falls back to a
 * completed frame; if neither is complete, returns the longer non-empty read flagged
 * `completed:false`, or `null` when both are empty.
 */
export function chooseDeepResearchReportRead(
    targetRead: RawReportRead | null,
    frameRead: RawReportRead | null,
): DeepResearchReportRead | null {
    const shape = (read: RawReportRead, fallbackFrom: string): { text: string; sources: string[]; from: string } => ({
        text: normalizeDeepResearchReportText(read?.text),
        sources: Array.isArray(read?.sources) ? read.sources : [],
        from: read?.from || fallbackFrom,
    });
    const target = targetRead ? shape(targetRead, 'target') : null;
    const frame = frameRead ? shape(frameRead, 'frame') : null;

    if (target?.text && !isIncompleteDeepResearchText(target.text)) return { ...target, completed: true };
    if (frame?.text && !isIncompleteDeepResearchText(frame.text)) return { ...frame, completed: true };

    const candidates = [target, frame].filter(
        (r): r is { text: string; sources: string[]; from: string } => Boolean(r && r.text),
    );
    const best = candidates.sort((a, b) => b.text.length - a.text.length)[0];
    if (!best) return null;
    return { ...best, completed: false };
}
