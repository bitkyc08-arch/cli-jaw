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

const MAX_NOTICE_CHARS = 1200;
const MAX_PREVIEW_CHARS = 600;

function compactLine(value: unknown, max: number): string {
    return previewText(value, max) || '';
}

export function buildWorkerReplayNotice(input: WorkerReplayNoticeInput): string {
    const preview = compactLine(input.text, MAX_PREVIEW_CHARS);
    const task = compactLine(input.taskPreview, 180);
    const name = input.employeeName && input.employeeName !== input.agentId
        ? ` (${input.employeeName})`
        : '';
    const toolCount = input.tools?.length ? `\nTool steps captured: ${input.tools.length}` : '';
    const notice = [
        `[worker-replay agent=${input.agentId}${name} run=${input.runId} — delayed result available]`,
        `The original dispatch connection dropped before delivery. The full worker output is not injected here by default.`,
        task ? `Task: ${task}` : '',
        preview ? `Preview: ${preview}` : 'Preview: (empty result)',
        toolCount,
        `Recovery:`,
        `- cli-jaw worker status ${input.runId}`,
        `- cli-jaw worker read ${input.runId} --tail 120`,
    ].filter(Boolean).join('\n');

    return notice.length > MAX_NOTICE_CHARS
        ? `${notice.slice(0, MAX_NOTICE_CHARS - 1)}…`
        : notice;
}
