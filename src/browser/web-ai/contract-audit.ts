import { createHash, randomUUID } from 'node:crypto';
import { wrapError } from './errors.js';
import type { WebAiVendor } from './types.js';

export interface ContractTarget {
    roles?: string[];
    names?: RegExp[];
}

export interface ContractSnapshotRef {
    ref?: string;
    role: string;
    name?: string;
}

export interface ContractSnapshot {
    snapshotId: string;
    refs: ContractSnapshotRef[];
}

export interface ContractDrift {
    feature: string;
    severity: 'error' | 'warn';
    message: string;
}

export interface ContractAuditReport {
    vendor: WebAiVendor;
    snapshotId: string;
    driftCount: number;
    errors: ContractDrift[];
    warnings: ContractDrift[];
    drifts: ContractDrift[];
}

export interface ContractAuditPage {
    accessibility?: {
        snapshot(options?: { interestingOnly?: boolean }): Promise<unknown>;
    };
}

const CONTRACTS: Record<WebAiVendor, Record<string, ContractTarget>> = {
    chatgpt: {
        composer: { roles: ['textbox'], names: [/message/i, /prompt/i, /chatgpt/i] },
        modelPicker: { roles: ['button', 'combobox'], names: [/model/i, /gpt/i] },
        uploadSurface: { roles: ['button'], names: [/attach/i, /upload/i, /file/i, /add/i] },
        copyButton: { roles: ['button'], names: [/copy/i] },
    },
    gemini: {
        composer: { roles: ['textbox'], names: [/prompt/i, /message/i, /ask/i] },
        modelPicker: { roles: ['button', 'combobox'], names: [/model/i, /mode/i, /picker/i] },
        uploadSurface: { roles: ['button'], names: [/upload/i, /file/i, /attach/i] },
        copyButton: { roles: ['button'], names: [/copy/i] },
    },
    grok: {
        composer: { roles: ['textbox'], names: [/message/i, /prompt/i, /ask/i, /grok/i] },
        modelPicker: { roles: ['button', 'combobox'], names: [/model/i] },
        uploadSurface: { roles: ['button'], names: [/upload/i, /attach/i, /file/i] },
        copyButton: { roles: ['button'], names: [/copy/i] },
    },
};

export async function auditContractAgainstSnapshot(page: ContractAuditPage, vendor: WebAiVendor): Promise<ContractAuditReport> {
    try {
        const contract = CONTRACTS[vendor] || CONTRACTS.chatgpt;
        const snapshot = await buildContractSnapshot(page);
        const drifts: ContractDrift[] = [];
        for (const [feature, target] of Object.entries(contract)) {
            const matches = snapshot.refs.filter((ref) => {
                const roleMatches = !target.roles?.length || target.roles.includes(ref.role);
                const nameMatches = !target.names?.length || target.names.some((pattern) => pattern.test(ref.name || ''));
                return roleMatches && nameMatches;
            });
            if (matches.length === 0) {
                drifts.push({ feature, severity: 'error', message: `No elements match contract for ${feature}` });
            } else if (matches.length > 1) {
                drifts.push({ feature, severity: 'warn', message: `Ambiguous match: ${matches.length} elements for ${feature}` });
            }
        }
        return {
            vendor,
            snapshotId: snapshot.snapshotId,
            driftCount: drifts.length,
            errors: drifts.filter((drift) => drift.severity === 'error'),
            warnings: drifts.filter((drift) => drift.severity === 'warn'),
            drifts,
        };
    } catch (err) {
        throw wrapError(err, {
            errorCode: 'internal.unhandled',
            stage: 'contract-audit',
            retryHint: 're-snapshot',
        });
    }
}

async function buildContractSnapshot(page: ContractAuditPage): Promise<ContractSnapshot> {
    if (!page.accessibility?.snapshot) {
        return { snapshotId: randomUUID(), refs: [] };
    }
    const tree = await page.accessibility.snapshot({ interestingOnly: true });
    const refs: ContractSnapshotRef[] = [];
    walkAx(tree, (node, index) => {
        const role = String(node.role || '').toLowerCase();
        if (!role) return;
        refs.push({
            ref: `@e${index + 1}`,
            role,
            name: typeof node.name === 'string' ? node.name : '',
        });
    });
    const hash = createHash('sha256').update(JSON.stringify(refs)).digest('hex').slice(0, 12);
    return { snapshotId: `contract-${hash}`, refs };
}

function walkAx(node: unknown, visit: (node: { role?: unknown; name?: unknown }, index: number) => void): void {
    const stack = [node];
    let index = 0;
    while (stack.length) {
        const current = stack.shift();
        if (!current || typeof current !== 'object') continue;
        visit(current as { role?: unknown; name?: unknown }, index);
        index += 1;
        const children = (current as { children?: unknown }).children;
        if (Array.isArray(children)) stack.push(...children);
    }
}
