// ─── Orchestrator Parsing + Triage ───────────────────
// Extracted from orchestrator.js for 500-line compliance.

// "이어서 해줘" 계열은 명시적인 짧은 명령만 continue intent로 취급
const CONTINUE_PATTERNS = [
    /^\/?continue$/i,
    /^이어서(?:\s*해줘)?$/i,
    /^계속(?:\s*해줘)?$/i,
];

export function isContinueIntent(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    return CONTINUE_PATTERNS.some(re => re.test(t));
}

// ─── Message Triage: 복잡한 작업만 orchestrate ───────

const CODE_KEYWORDS = /\.(js|ts|jsx|tsx|py|md|json|css|html|sql|yml|yaml|sh|go|rs|swift)|구현|작성|만들어|수정|코딩|리팩|버그|에러|디버그|테스트|빌드|설치|배포|삭제|추가|변경|생성|개발|엔드포인트|서버|라우트|스키마|컴포넌트|모듈|함수|클래스|\bAPI\b|\bDB\b/i;
const FILE_PATH_PATTERN = /(?:src|bin|public|lib|devlog|config|components?|pages?|api)\//i;
const MULTI_TASK_PATTERN = /(?:그리고|다음에|먼저|또한|추가로|\n\n|\d+\.\s)/;

export function needsOrchestration(text) {
    const t = String(text || '').trim();
    if (!t) return false;

    let signals = 0;

    // Signal 1: 길이 (80자 이상)
    if (t.length >= 80) signals++;

    // Signal 2: 코드 키워드 카운트
    const codeMatches = t.match(CODE_KEYWORDS);
    if (codeMatches) signals++;
    // 2개 이상의 서로 다른 코드 키워드 → 추가 signal
    const allCodeMatches = [...new Set((t.match(new RegExp(CODE_KEYWORDS.source, 'gi')) || []))];
    if (allCodeMatches.length >= 2) signals++;

    // Signal 3: 파일 경로 패턴
    if (FILE_PATH_PATTERN.test(t)) signals++;

    // Signal 4: 멀티 태스크 신호
    if (MULTI_TASK_PATTERN.test(t)) signals++;

    return signals >= 2;
}

// ─── JSON Parsing (export 유지 — agent.js가 import) ──

export function parseSubtasks(text) {
    if (!text) return null;
    const fenced = text.match(/```json\n([\s\S]*?)\n```/);
    if (fenced) {
        try { return JSON.parse(fenced[1]).subtasks || null; } catch (e) { console.debug('[orchestrator:subtask] fenced JSON parse failed', { preview: String(fenced[1]).slice(0, 80) }); }
    }
    const raw = text.match(/(\{[\s\S]*"subtasks"\s*:\s*\[[\s\S]*\]\s*\})/);
    if (raw) {
        try { return JSON.parse(raw[1]).subtasks || null; } catch (e) { console.debug('[orchestrator:subtask] raw JSON parse failed', { preview: String(raw[1]).slice(0, 80) }); }
    }
    return null;
}

export function parseDirectAnswer(text) {
    if (!text) return null;
    // Fenced JSON block
    const fenced = text.match(/```json\n([\s\S]*?)\n```/);
    if (fenced) {
        try {
            const obj = JSON.parse(fenced[1]);
            if (obj.direct_answer && (!obj.subtasks || obj.subtasks.length === 0)) {
                return obj.direct_answer;
            }
        } catch { /* expected: fenced JSON may not contain direct_answer */ }
    }
    // Raw JSON
    const raw = text.match(/(\{[\s\S]*"direct_answer"\s*:[\s\S]*\})/);
    if (raw) {
        try {
            const obj = JSON.parse(raw[1]);
            if (obj.direct_answer && (!obj.subtasks || obj.subtasks.length === 0)) {
                return obj.direct_answer;
            }
        } catch { /* expected: raw JSON may not contain direct_answer */ }
    }
    return null;
}

export function stripSubtaskJSON(text) {
    return text
        .replace(/```json\n[\s\S]*?\n```/g, '')
        .replace(/\{[\s\S]*"subtasks"\s*:\s*\[[\s\S]*?\]\s*\}/g, '')
        .trim();
}

// ─── Verdict JSON Parsing (이중 전략) ────────────────

export function parseVerdicts(text) {
    if (!text) return null;
    try {
        const fenced = text.match(/```(?:json)?\n([\s\S]*?)\n```/);
        if (fenced) return JSON.parse(fenced[1]);
    } catch { /* expected: fenced JSON may not exist or be malformed */ }
    try {
        const raw = text.match(/\{[\s\S]*"verdicts"[\s\S]*\}/);
        if (raw) return JSON.parse(raw[0]);
    } catch { /* expected: raw JSON may not exist or be malformed */ }
    return null;
}
