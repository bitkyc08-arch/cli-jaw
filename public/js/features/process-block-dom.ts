import { ICONS } from '../icons.js';
import {
    getStoredProcessStepDetail,
    processStepMetaFromStore,
    registerProcessBlockState,
    releaseProcessBlockDetails,
    type ProcessBlockState,
    type ProcessStep,
} from './process-block.js';
import type { ToolLogEntry } from './tool-ui.js';

const TOOL_BLOCK_SELECTOR =
    ':scope > .process-block, :scope > .tool-group, ' +
    ':scope > .msg-content > .process-block, :scope > .msg-content > .tool-group';

function agentBody(agentMsg: HTMLElement): HTMLElement | null {
    return agentMsg.querySelector('.agent-body') as HTMLElement | null;
}

function agentToolBlocks(agentMsg: HTMLElement): HTMLElement[] {
    const body = agentBody(agentMsg);
    return body ? Array.from(body.querySelectorAll<HTMLElement>(TOOL_BLOCK_SELECTOR)) : [];
}

function preferredAgentToolBlock(body: HTMLElement): HTMLElement | null {
    const content = body.querySelector(':scope > .msg-content') as HTMLElement | null;
    return body.querySelector(':scope > .process-block')
        ?? body.querySelector(':scope > .tool-group')
        ?? content?.querySelector(':scope > .process-block')
        ?? content?.querySelector(':scope > .tool-group')
        ?? null;
}

export function normalizeAgentToolBlocks(agentMsg: HTMLElement): void {
    const body = agentBody(agentMsg);
    if (!body) return;
    const content = body.querySelector('.msg-content') as HTMLElement | null;
    const blocks = agentToolBlocks(agentMsg);
    if (blocks.length === 0) return;
    const keep = preferredAgentToolBlock(body) ?? blocks[0];
    if (content && keep.parentElement !== body) body.insertBefore(keep, content);
    for (const block of blocks) {
        if (block !== keep) {
            releaseProcessBlockDetails(block);
            block.remove();
        }
    }
}

export function hasAgentToolBlock(agentMsg: HTMLElement): boolean {
    return agentToolBlocks(agentMsg).length > 0;
}

function processStepTypeFromDom(type?: string): ProcessStep['type'] {
    return type === 'thinking' || type === 'search' || type === 'subagent' ? type : 'tool';
}

function processStepStatusFromDom(status?: string): ProcessStep['status'] {
    return status === 'done' || status === 'error' ? status : 'running';
}

function processStepFromDom(row: HTMLElement): ProcessStep | null {
    const id = row.dataset['stepId'] || '';
    if (!id) return null;
    const storedMeta = processStepMetaFromStore(id);
    const label = row.querySelector('.process-step-label')?.textContent?.trim() || '';
    const pre = row.querySelector('.process-step-full') as HTMLElement | null;
    const detail = pre?.dataset['detailLazy'] === 'true'
        ? getStoredProcessStepDetail(id) || storedMeta?.preview || ''
        : pre?.textContent || getStoredProcessStepDetail(id) || storedMeta?.preview || '';
    const iconEl = row.querySelector('.process-step-icon') as HTMLElement | null;
    const icon = iconEl?.innerHTML || ICONS.tool;
    const startTime = Number(row.dataset['startTime'] || '');
    return {
        id,
        type: storedMeta?.type || processStepTypeFromDom(row.dataset['type']),
        icon: storedMeta?.icon || icon,
        rawIcon: storedMeta?.rawIcon,
        label: storedMeta?.label || label,
        isEmployee: storedMeta?.isEmployee === true || row.dataset['isEmployee'] === 'true',
        detail,
        detailPreview: storedMeta?.preview,
        detailLength: storedMeta?.detailLength,
        detailTruncated: storedMeta?.detailTruncated,
        stepRef: storedMeta?.stepRef || row.dataset['stepRef'] || '',
        traceRunId: storedMeta?.traceRunId || row.dataset['traceRunId'] || '',
        traceSeq: storedMeta?.traceSeq || Number(row.dataset['traceSeq'] || 0) || undefined,
        detailAvailable: storedMeta?.detailAvailable,
        detailBytes: storedMeta?.detailBytes,
        rawRetentionStatus: storedMeta?.rawRetentionStatus,
        status: storedMeta?.status || processStepStatusFromDom(row.dataset['status']),
        startTime: Number.isFinite(startTime) && startTime > 0 ? startTime : Date.now(),
    };
}

export function currentProcessBlockFromDom(agentMsg: HTMLElement): ProcessBlockState | null {
    const block = agentBody(agentMsg)?.querySelector(':scope > .process-block') as HTMLElement | null;
    if (!block) return null;
    const steps = Array.from(block.querySelectorAll<HTMLElement>('.process-step'))
        .map(processStepFromDom)
        .filter((step): step is ProcessStep => Boolean(step));
    const state: ProcessBlockState = { element: block, steps, collapsed: block.classList.contains('collapsed') };
    // Register so the click handler can sync pb.collapsed / drive the ticker for
    // hydrated live blocks too (WP3 — DOM-reconstructed states were unregistered).
    registerProcessBlockState(state);
    return state;
}

function processStepToToolLog(step: ProcessStep, finalize = false): ToolLogEntry {
    const detail = getStoredProcessStepDetail(step.id) || step.detail || step.detailPreview || '';
    const status = finalize && step.status === 'running' ? 'done' : step.status;
    return {
        icon: step.rawIcon || step.icon || ICONS.tool,
        rawIcon: step.rawIcon || step.icon || '',
        label: step.label || 'tool',
        isEmployee: step.isEmployee === true,
        detail,
        toolType: step.type,
        stepRef: step.stepRef || '',
        status,
        traceRunId: step.traceRunId || '',
        traceSeq: step.traceSeq,
        detailAvailable: step.detailAvailable,
        detailBytes: step.detailBytes,
        rawRetentionStatus: step.rawRetentionStatus,
    };
}

function processStepFromMeta(stepId: string, finalize = false): ToolLogEntry | null {
    const meta = processStepMetaFromStore(stepId);
    if (!meta) return null;
    const status = finalize && meta.status === 'running' ? 'done' : meta.status;
    return {
        icon: meta.rawIcon || meta.icon || ICONS.tool,
        rawIcon: meta.rawIcon || meta.icon || '',
        label: meta.label || 'tool',
        isEmployee: meta.isEmployee === true,
        detail: getStoredProcessStepDetail(stepId) || meta.preview || '',
        toolType: meta.type,
        stepRef: meta.stepRef || '',
        status,
        traceRunId: meta.traceRunId || '',
        traceSeq: meta.traceSeq,
        detailAvailable: meta.detailAvailable,
        detailBytes: meta.detailBytes,
        rawRetentionStatus: meta.rawRetentionStatus,
    };
}

export function serializeProcessStepsForToolLog(source: ProcessBlockState | HTMLElement | null, finalize = false): ToolLogEntry[] {
    if (!source) return [];
    if ('steps' in source) return source.steps.map(step => processStepToToolLog(step, finalize));
    const ids = new Set<string>();
    source.querySelectorAll<HTMLElement>('.process-block[data-process-step-ids]').forEach(block => {
        (block.dataset['processStepIds'] || '').split(/\s+/).filter(Boolean).forEach(id => ids.add(id));
    });
    source.querySelectorAll<HTMLElement>('.process-step[data-step-id]').forEach(row => {
        const id = row.dataset['stepId'];
        if (id) ids.add(id);
    });
    const entries: ToolLogEntry[] = [];
    ids.forEach(id => {
        const fromMeta = processStepFromMeta(id, finalize);
        if (fromMeta) {
            entries.push(fromMeta);
            return;
        }
        const row = source.querySelector<HTMLElement>(`.process-step[data-step-id="${CSS.escape(id)}"]`);
        const step = row ? processStepFromDom(row) : null;
        if (step) entries.push(processStepToToolLog(step, finalize));
    });
    return entries;
}

export function removeAgentToolBlocks(agentMsg: HTMLElement): void {
    for (const block of agentToolBlocks(agentMsg)) {
        releaseProcessBlockDetails(block);
        block.remove();
    }
}
