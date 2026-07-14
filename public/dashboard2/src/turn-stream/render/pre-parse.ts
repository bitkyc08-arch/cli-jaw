export const preParseVersion = 'r1.1';

export interface PreParsedMarkdown {
    source: string;
    changed: boolean;
    preParseVersion: string;
}

const ORCH_KEYS = /["'](?:subtasks|employee_config|agent_phases|orchestration_plan)["']\s*:/;
const PROMPT_LEAK_START = /(^|\n)(?:## Approved Plan \((?:authoritative|auto-injected by orchestrator)[^\n]*\)|\[PABCD — [A-Z]:[^\n]*\]|\[PLANNING MODE[^\n]*\]|\[PLAN AUDIT[^\n]*\]|The approved plan is already injected above)/m;

function stripPromptLeakage(text: string): string {
    const match = PROMPT_LEAK_START.exec(text);
    return match ? text.slice(0, match.index).trim() : text;
}

function stripOrchestration(text: string): string {
    const fenced = text.replace(/```json\n([\s\S]*?)\n```/g, (match, inner: string) =>
        ORCH_KEYS.test(inner) ? '' : match);
    return stripPromptLeakage(
        fenced.replace(/\{[^{}]*"subtasks"\s*:\s*\[[\s\S]*?\]\s*\}/g, '').trim(),
    );
}

function fixCjkPunctuationBoundary(text: string): string {
    const preserved: string[] = [];
    const protect = (match: string): string => {
        preserved.push(match);
        return `\x00P${preserved.length - 1}\x00`;
    };
    const processed = text.replace(/```[\s\S]*?```/g, protect).replace(/`[^`]+`/g, protect)
        .replace(/([\p{P}])\*\*(?=[^\s\p{P}])/gu,
            (match, punct: string) => punct === '*' ? match : `${punct}\u200B**`);
    return processed.replace(/\x00P(\d+)\x00/g, (_match, index: string) => preserved[Number(index)] ?? '');
}

export function preParseMarkdown(raw: string): PreParsedMarkdown {
    const source = fixCjkPunctuationBoundary(stripOrchestration(raw));
    return { source, changed: source !== raw, preParseVersion };
}
