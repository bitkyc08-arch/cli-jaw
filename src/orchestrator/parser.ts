// ─── Orchestrator Parsing + Triage ───────────────────
// Extracted from orchestrator.js for 500-line compliance.

// "이어서 해줘" 계열은 명시적인 짧은 명령만 continue intent로 취급
const CONTINUE_PATTERNS = [
    /^\/?continue$/i,
    /^again$/i,
    /^이어서(?:\s*해줘)?$/i,
    /^계속(?:\s*해줘)?$/i,
    /^다시(?:\s*해줘)?$/i,
    /^다음(?:\s*해봐)?$/i,
    /^리뷰(?:\s*해봐)?$/i,
];

export function isContinueIntent(text: string) {
    const t = String(text || '').trim();
    if (!t) return false;
    return CONTINUE_PATTERNS.some(re => re.test(t));
}

// ─── Reset Intent ────────────────────────────────────

const RESET_PATTERNS = [
    /^리셋해?$/i,
    /^초기화해?$/i,
    /^페이즈?\s*리셋해?$/i,
    /^phase\s*reset$/i,
    /^reset$/i,
];

export function isResetIntent(text: string) {
    const t = String(text || '').trim();
    if (!t) return false;
    return RESET_PATTERNS.some(re => re.test(t));
}

// ─── Approve Intent (PABCD phase advance) ────────────

const APPROVE_PATTERNS = [
    /^(?:ok|okay|lgtm|approved?|확인|좋아|진행|넘어가|다음\s*단계)$/i,
    /^(?:go|next|proceed|ㅇㅋ|ㄱㄱ)$/i,
];

export function isApproveIntent(text: string) {
    const t = String(text || '').trim();
    if (!t) return false;
    return APPROVE_PATTERNS.some(re => re.test(t));
}

// ─── JSON Parsing (DEPRECATED — patch3에서 cli-jaw dispatch로 통일) ──
// 하위호환 fallback으로 export 유지. 신규 코드에서 사용 금지.

export function parseSubtasks(text: string) {
    if (!text) return null;
    const fenced = text.match(/```json\n([\s\S]*?)\n```/);
    if (fenced) {
        try { return JSON.parse(fenced[1]!).subtasks || null; } catch (e) { console.debug('[orchestrator:subtask] fenced JSON parse failed', { preview: String(fenced[1]).slice(0, 80) }); }
    }
    const raw = text.match(/(\{[\s\S]*"subtasks"\s*:\s*\[[\s\S]*\]\s*\})/);
    if (raw) {
        try { return JSON.parse(raw[1]!).subtasks || null; } catch (e) { console.debug('[orchestrator:subtask] raw JSON parse failed', { preview: String(raw[1]).slice(0, 80) }); }
    }
    return null;
}

export function parseDirectAnswer(text: string) {
    if (!text) return null;
    // Fenced JSON block
    const fenced = text.match(/```json\n([\s\S]*?)\n```/);
    if (fenced) {
        try {
            const obj = JSON.parse(fenced[1]!);
            if (obj.direct_answer && (!obj.subtasks || obj.subtasks.length === 0)) {
                return obj.direct_answer;
            }
        } catch { /* expected: fenced JSON may not contain direct_answer */ }
    }
    // Raw JSON
    const raw = text.match(/(\{[\s\S]*"direct_answer"\s*:[\s\S]*\})/);
    if (raw) {
        try {
            const obj = JSON.parse(raw[1]!);
            if (obj.direct_answer && (!obj.subtasks || obj.subtasks.length === 0)) {
                return obj.direct_answer;
            }
        } catch { /* expected: raw JSON may not contain direct_answer */ }
    }
    return null;
}

export function stripSubtaskJSON(text: string) {
    return text
        .replace(/```json\n[\s\S]*?\n```/g, '')
        .replace(/\{[\s\S]*"subtasks"\s*:\s*\[[\s\S]*?\]\s*\}/g, '')
        .trim();
}

// ─── Numeric Reference Resolution ───────────────────

export interface ResolvedSelection {
    raw: string;
    index: number;
    text: string;
    source: 'latest_assistant_numbered_list';
}

export interface NumericReferenceResolution {
    resolved: string | null;
    needsConfirmation: boolean;
    matchedIndex?: number;
    selection?: ResolvedSelection;
}

interface RecentMessageLike {
    role?: string | null;
    content?: string | null;
}

function extractRequestedIndex(text: string): number | null {
    const trimmed = String(text || '').trim();
    const match = trimmed.match(/^(\d+)\s*(?:번|[.):])?/);
    if (!match) return null;
    const index = Number(match[1]);
    return Number.isInteger(index) && index > 0 ? index : null;
}

function extractNumberedItem(content: string, index: number): string | null {
    const itemPattern = new RegExp(`^\\s*${index}[.):]\\s+(.+?)\\s*$`);
    for (const line of String(content || '').split(/\r?\n/)) {
        const match = line.match(itemPattern);
        if (match?.[1]) return match[1].trim();
    }
    return null;
}

export function resolveNumericReference(
    text: string,
    messages: RecentMessageLike[],
): NumericReferenceResolution | null {
    const index = extractRequestedIndex(text);
    if (!index) return null;

    for (const message of messages) {
        if (message.role !== 'assistant') continue;
        const item = extractNumberedItem(String(message.content || ''), index);
        if (!item) continue;
        const selection: ResolvedSelection = {
            raw: String(text || '').trim(),
            index,
            text: item,
            source: 'latest_assistant_numbered_list',
        };
        return {
            resolved: item,
            needsConfirmation: false,
            matchedIndex: index,
            selection,
        };
    }

    return {
        resolved: null,
        needsConfirmation: true,
        matchedIndex: index,
    };
}

// ─── Verdict JSON Parsing (이중 전략) ────────────────

export function parseVerdicts(text: string) {
    if (!text) return null;
    try {
        const fenced = text.match(/```(?:json)?\n([\s\S]*?)\n```/);
        if (fenced) return JSON.parse(fenced[1]!);
    } catch { /* expected: fenced JSON may not exist or be malformed */ }
    try {
        const raw = text.match(/\{[\s\S]*"verdicts"[\s\S]*\}/);
        if (raw) return JSON.parse(raw[0]);
    } catch { /* expected: raw JSON may not exist or be malformed */ }
    return null;
}
