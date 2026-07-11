import type { MessageItem, ToolLogEntry } from '../../../src/shared/chat-events.js';

export const GOLDEN_SVG_ICON = '<svg data-golden="tool"></svg>';
export const TOOL_DETAIL_SECRET = 'SECRET_SENTINEL_043_DO_NOT_RETAIN';
export const TRACE_RUN_ID = 'tr_dashboard2golden0001';

export interface ToolLogGoldenCase {
    name: string;
    raw: string | null;
    expectedLength: number;
}

export const toolLogGoldenCases: readonly ToolLogGoldenCase[] = [
    {
        name: 'trace identity',
        raw: JSON.stringify([
            { icon: GOLDEN_SVG_ICON, label: 'build', detail: 'running', toolType: 'tool', status: 'running', stepRef: 'step-1', traceRunId: TRACE_RUN_ID, traceSeq: 7 },
            { icon: GOLDEN_SVG_ICON, label: 'search', detail: 'done', toolType: 'search', status: 'done', traceRunId: TRACE_RUN_ID, traceSeq: 8 },
        ]),
        expectedLength: 2,
    },
    { name: 'malformed json', raw: '{not-json', expectedLength: 0 },
    { name: 'null', raw: null, expectedLength: 0 },
    {
        name: 'employee interleave',
        raw: JSON.stringify([
            { icon: GOLDEN_SVG_ICON, label: 'inspect', toolType: 'tool', status: 'running', traceRunId: TRACE_RUN_ID, traceSeq: 11 },
            { icon: GOLDEN_SVG_ICON, label: 'inspect', toolType: 'tool', status: 'done', isEmployee: true, traceRunId: TRACE_RUN_ID, traceSeq: 12 },
            { icon: GOLDEN_SVG_ICON, label: 'inspect', toolType: 'tool', status: 'done', traceRunId: TRACE_RUN_ID, traceSeq: 11 },
        ]),
        expectedLength: 3,
    },
    {
        name: 'missing detail',
        raw: JSON.stringify([{ icon: GOLDEN_SVG_ICON, label: 'empty', toolType: 'tool', status: 'done' }]),
        expectedLength: 1,
    },
];

export const liveToolLog: ToolLogEntry[] = [
    { icon: GOLDEN_SVG_ICON, label: 'compile', detail: 'short', toolType: 'tool', status: 'running', stepRef: 'compile-1', traceRunId: TRACE_RUN_ID, traceSeq: 20 },
    { icon: GOLDEN_SVG_ICON, label: 'review', detail: 'employee live', toolType: 'subagent', status: 'running', isEmployee: true },
];

export const explicitToolLog: ToolLogEntry[] = [
    { icon: GOLDEN_SVG_ICON, label: 'compile', detail: 'longer explicit detail', toolType: 'tool', status: 'done', stepRef: 'compile-1', traceRunId: TRACE_RUN_ID, traceSeq: 20 },
    { icon: GOLDEN_SVG_ICON, label: 'review', detail: '', toolType: 'subagent', status: 'done', isEmployee: true },
];

export const assistantMessage: MessageItem = {
    id: 43,
    role: 'assistant',
    content: 'done',
    tool_log: toolLogGoldenCases[0]!.raw,
};

export const oversizedDetail = `${'detail-line\n'.repeat(1200)}${TOOL_DETAIL_SECRET}${'\ntail'.repeat(1200)}`;
