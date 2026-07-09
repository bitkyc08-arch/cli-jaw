import type { SanitizedToolLogEntry } from '../shared/tool-log-sanitize.js';
import { previewText } from './worker-progress.js';

export interface WorkerReplayNoticeInput {
    agentId: string;
    runId: string;
    employeeName?: string;
    taskPreview?: string;
    text: string;
    tools?: SanitizedToolLogEntry[];
}

// 260703 full-result replay (WP7): the notice carries the worker's FULL final
// text (Claude Code task-notification / codex-rs completion-watcher model)
// instead of a 600-char receipt. Longer results clip head+tail — the tail is
// preserved because employees put verdict lines last.
const FULL_RESULT_MAX = 8000;
const CLIP_HEAD_CHARS = 6000;
const CLIP_TAIL_CHARS = 2000;
const MAX_NOTICE_CHARS = 9800;
const MAX_NAME_CHARS = 60;
const MAX_AGENT_ID_CHARS = 80;

function compactLine(value: unknown, max: number): string {
    return previewText(value, max) || '';
}

export function buildWorkerReplayNotice(input: WorkerReplayNoticeInput): string {
    const task = compactLine(input.taskPreview, 180);
    // Result block uses RAW slices — previewText collapses newlines, which
    // would flatten exactly the multi-line reports this notice exists to carry.
    const rawText = String(input.text || '');
    const agentId = compactLine(input.agentId, MAX_AGENT_ID_CHARS);
    const name = input.employeeName && input.employeeName !== input.agentId
        ? ` (${compactLine(input.employeeName, MAX_NAME_CHARS)})`
        : '';
    const toolCount = input.tools?.length ? `Tool steps captured: ${input.tools.length}` : '';
    const clipped = rawText.length > FULL_RESULT_MAX;
    const resultBlock = !rawText.trim()
        ? 'Result: (empty result)'
        : clipped
            ? [
                'Result (clipped — read the full output via the command below):',
                rawText.slice(0, CLIP_HEAD_CHARS),
                `…[${rawText.length - CLIP_HEAD_CHARS - CLIP_TAIL_CHARS} chars omitted]…`,
                rawText.slice(-CLIP_TAIL_CHARS),
            ].join('\n')
            : `Result:\n${rawText}`;
    const notice = [
        `[worker-replay agent=${agentId}${name} run=${input.runId} — worker completed, result below]`,
        task ? `Task: ${task}` : '',
        resultBlock,
        toolCount,
        `Full log: cli-jaw worker read ${input.runId} --tail 120`,
        ...(clipped ? [`Status: cli-jaw worker status ${input.runId}`] : []),
    ].filter(Boolean).join('\n');

    return notice.length > MAX_NOTICE_CHARS
        ? `${notice.slice(0, MAX_NOTICE_CHARS - 1)}…`
        : notice;
}
