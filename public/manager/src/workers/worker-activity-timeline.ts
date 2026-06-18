import type { WorkerProgressRun, WorkerProgressTool } from './worker-progress-client';

export type WorkerActivityKind = 'dispatch' | 'subagent' | 'tool' | 'attention' | 'result';

export interface WorkerActivityItem {
    id: string;
    kind: WorkerActivityKind;
    label: string;
    detail: string;
    status: string;
}

function toolActivityKind(tool: WorkerProgressTool): WorkerActivityKind {
    const type = String(tool.toolType || '').toLowerCase();
    if (type === 'subagent' || type === 'worker' || tool.isEmployee === true) return 'subagent';
    return 'tool';
}

function toolLabel(tool: WorkerProgressTool, fallback: string): string {
    const type = toolActivityKind(tool);
    if (type === 'subagent') return tool.label || 'Subagent';
    return tool.label || tool.toolType || fallback;
}

export function buildWorkerActivityTimeline(run: WorkerProgressRun): WorkerActivityItem[] {
    const items: WorkerActivityItem[] = [{
        id: `${run.agentId}:dispatch`,
        kind: 'dispatch',
        label: `${run.employeeName} dispatched`,
        detail: run.taskPreview || 'No task preview',
        status: run.state === 'running' ? 'running' : run.state,
    }];

    run.tools.forEach((tool, index) => {
        const kind = toolActivityKind(tool);
        items.push({
            id: tool.stepRef || `${run.agentId}:tool:${index}`,
            kind,
            label: toolLabel(tool, kind === 'subagent' ? 'Subagent' : 'Tool'),
            detail: tool.detail || '',
            status: tool.status || 'step',
        });
    });

    if (run.attention) {
        items.push({
            id: `${run.agentId}:attention:${run.attention.kind}`,
            kind: 'attention',
            label: run.attention.kind.replaceAll('_', ' '),
            detail: run.attention.message,
            status: 'attention',
        });
    }

    if (run.resultPreview) {
        items.push({
            id: `${run.agentId}:result`,
            kind: 'result',
            label: 'Result available',
            detail: run.resultPreview,
            status: run.state,
        });
    }

    return items;
}
