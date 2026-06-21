export type ToolContent = {
    type: 'args' | 'output' | 'error' | 'diff' | 'json' | 'text';
    label?: string;
    text?: string;
    diff?: string;
    json?: unknown;
    [key: string]: unknown;
};

export type TranscriptEntry = {
    role: 'user' | 'assistant' | 'tool' | 'thinking' | 'permission';
    text: string;
    transient?: 'pending-user-echo';
    toolName?: string;
    toolStatus?: string;
    toolCallId?: string;
    toolContent?: ToolContent[];
    toolOutput?: string;
    permissionAudit?: PermissionAudit;
};

export type PendingPermission = {
    permissionId: string;
    toolCall: Record<string, unknown>;
    options: Array<Record<string, unknown>>;
};

export type PermissionMode = 'ask' | 'always-allow' | 'always-deny';

export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

export type PermissionActionTone = 'allow-once' | 'allow-always' | 'deny-once' | 'deny-always';

export type PermissionModeTone = 'allow' | 'ask' | 'deny';

export type PermissionModeOption = {
    value: PermissionMode;
    label: string;
    detail: string;
    tone: PermissionModeTone;
};

export type PermissionDecisionKind = PermissionOptionKind | 'pending' | 'cancelled' | 'missing_option' | 'answer_error';

export type ResolvedPermissionOption = {
    kind: PermissionOptionKind;
    optionId: string;
    label: string;
    raw: Record<string, unknown>;
};

export type PermissionAudit = {
    permissionId: string;
    toolName: string;
    mode: PermissionMode;
    decision: PermissionDecisionKind;
    decisionMode: 'pending' | 'manual' | 'automatic' | 'system';
    optionId?: string;
    optionLabel?: string;
    error?: string;
};

export type CodeCommandCategory =
    | 'settings'
    | 'model'
    | 'provider'
    | 'session'
    | 'workflow'
    | 'prompt'
    | 'custom'
    | 'skill'
    | 'utility'
    | 'unknown';

export type CodeCommandActionType = 'insert' | 'popup' | 'pass-through' | 'unsupported';

export type CodeCommandPopupKind = 'settings' | 'model' | 'provider' | 'session' | 'permission';

export type CodeCommandSource = 'jwc-builtin' | 'jwc-custom' | 'jwc-file' | 'jwc-skill' | 'cli-jaw' | 'unknown';

export type CodeCommand = {
    name: string;
    displayName: string;
    description?: string;
    inputHint?: string;
    category: CodeCommandCategory;
    actionType: CodeCommandActionType;
    popupKind?: CodeCommandPopupKind;
    source: CodeCommandSource;
    disabledReason?: string;
    raw: Record<string, unknown>;
};

export function findLastToolMessageIndex(messages: TranscriptEntry[], toolCallId: string): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message?.role === 'tool' && message.toolCallId === toolCallId) return i;
    }
    return -1;
}

export function toModelId(provider: string, model: string): string {
    return provider ? `${provider}/${model}` : model;
}

export const PERMISSION_ACTION_ORDER: PermissionOptionKind[] = ['allow_once', 'allow_always', 'reject_once', 'reject_always'];

export const PERMISSION_ACTION_LABELS: Record<PermissionOptionKind, string> = {
    allow_once: 'Allow once',
    allow_always: 'Always allow',
    reject_once: 'Deny once',
    reject_always: 'Always deny',
};

export const PERMISSION_ACTION_TONES: Record<PermissionOptionKind, PermissionActionTone> = {
    allow_once: 'allow-once',
    allow_always: 'allow-always',
    reject_once: 'deny-once',
    reject_always: 'deny-always',
};

export const PERMISSION_MODE_OPTIONS: PermissionModeOption[] = [
    { value: 'always-allow', label: 'Always allow', detail: 'Auto-allow gated tools', tone: 'allow' },
    { value: 'ask', label: 'Ask first', detail: 'Review each gated tool', tone: 'ask' },
    { value: 'always-deny', label: 'Always deny', detail: 'Auto-deny gated tools', tone: 'deny' },
];

export const PERMISSION_MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
    ask: 'Review each gated tool',
    'always-allow': 'Auto-allow gated tools',
    'always-deny': 'Auto-deny gated tools',
};

const PERMISSION_KIND_PATTERNS: Record<PermissionOptionKind, RegExp> = {
    allow_once: /^(allow[_\s-]?once|allow once)$/i,
    allow_always: /^(allow[_\s-]?always|always allow|always approve)$/i,
    reject_once: /^(reject[_\s-]?once|deny[_\s-]?once|reject|deny)$/i,
    reject_always: /^(reject[_\s-]?always|deny[_\s-]?always|always reject|always deny)$/i,
};

function permissionOptionText(option: Record<string, unknown>): string {
    return [
        option['kind'],
        option['optionId'],
        option['id'],
        option['name'],
        option['label'],
    ].map(value => String(value ?? '')).join(' ').trim();
}

function permissionOptionId(option: Record<string, unknown>): string | null {
    const value = option['optionId'] ?? option['id'];
    return value === undefined || value === null || value === '' ? null : String(value);
}

function permissionOptionLabel(option: Record<string, unknown>, kind: PermissionOptionKind): string {
    const label = option['name'] ?? option['label'];
    return label === undefined || label === null || label === '' ? PERMISSION_ACTION_LABELS[kind] : String(label);
}

export function resolvePermissionOption(options: Array<Record<string, unknown>>, kind: PermissionOptionKind): ResolvedPermissionOption | null {
    const exactKind = options.find(option => option['kind'] === kind);
    const exactId = options.find(option => option['optionId'] === kind || option['id'] === kind);
    const labelMatch = options.find(option => PERMISSION_KIND_PATTERNS[kind].test(permissionOptionText(option)));
    const selected = exactKind ?? exactId ?? labelMatch;
    if (!selected) return null;
    const optionId = permissionOptionId(selected);
    if (!optionId) return null;
    return {
        kind,
        optionId,
        label: permissionOptionLabel(selected, kind),
        raw: selected,
    };
}

export function getPermissionToolName(toolCall: Record<string, unknown>): string {
    return String(toolCall['toolName'] ?? toolCall['title'] ?? toolCall['name'] ?? 'tool');
}

export function permissionAuditEntry(
    permission: PendingPermission,
    audit: Omit<PermissionAudit, 'permissionId' | 'toolName'>,
): TranscriptEntry {
    const permissionAudit: PermissionAudit = {
        permissionId: permission.permissionId,
        toolName: getPermissionToolName(permission.toolCall),
        ...audit,
    };
    return {
        role: 'permission',
        text: permissionAudit.error ?? permissionAudit.optionLabel ?? permissionAudit.decision,
        permissionAudit,
    };
}

function stringifyToolValue(value: unknown): string {
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

function textFromToolContentParts(value: unknown): string | null {
    if (!Array.isArray(value)) return null;
    const parts: string[] = [];
    for (const part of value) {
        if (typeof part === 'string') {
            if (part) parts.push(part);
            continue;
        }
        if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
        const record = part as Record<string, unknown>;
        const rawType = typeof record['type'] === 'string' ? record['type'].toLowerCase() : '';
        const text = record['text'];
        if ((!rawType || rawType === 'text') && typeof text === 'string' && text) parts.push(text);
    }
    return parts.length > 0 ? parts.join('\n') : null;
}

function textFromToolPayload(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const contentText = textFromToolContentParts(record['content']);
    if (contentText) return contentText;
    const details = record['details'];
    if (details && typeof details === 'object' && !Array.isArray(details)) {
        const displayContent = (details as Record<string, unknown>)['displayContent'];
        if (displayContent && typeof displayContent === 'object' && !Array.isArray(displayContent)) {
            const text = (displayContent as Record<string, unknown>)['text'];
            if (typeof text === 'string' && text) return text;
        }
    }
    return null;
}

function stringifyToolPayload(value: unknown): string {
    return textFromToolPayload(value) ?? stringifyToolValue(value);
}

function normalizeToolContentItem(raw: unknown): ToolContent | null {
    if (typeof raw === 'string') return { type: 'text', text: raw };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const rawType = typeof record['type'] === 'string' ? record['type'].toLowerCase() : '';
    const label = typeof record['label'] === 'string' ? record['label'] : undefined;
    if (rawType === 'diff' && typeof record['diff'] === 'string') return { type: 'diff', diff: record['diff'], ...(label ? { label } : {}) };
    if (rawType === 'error') return { type: 'error', text: stringifyToolValue(record['text'] ?? record['error'] ?? record['message'] ?? record), ...(label ? { label } : {}) };
    if (rawType === 'args' || rawType === 'arguments' || rawType === 'input') return { type: 'args', json: record['json'] ?? record['args'] ?? record['arguments'] ?? record['input'] ?? record, ...(label ? { label } : {}) };
    if (rawType === 'output') return { type: 'output', text: stringifyToolPayload(record['text'] ?? record['output'] ?? record), ...(label ? { label } : {}) };
    if (rawType === 'json') return { type: 'json', json: record['json'] ?? record['value'] ?? record, ...(label ? { label } : {}) };
    if (typeof record['diff'] === 'string') return { type: 'diff', diff: record['diff'], ...(label ? { label } : {}) };
    if (typeof record['text'] === 'string') return { type: 'text', text: record['text'], ...(label ? { label } : {}) };
    const payloadText = textFromToolPayload(record);
    if (payloadText) return { type: 'text', text: payloadText, ...(label ? { label } : {}) };
    return { type: 'json', json: record, ...(label ? { label } : {}) };
}

function pushToolFieldContent(content: ToolContent[], type: ToolContent['type'], label: string, value: unknown): void {
    if (value === undefined || value === null || value === '') return;
    if (type === 'args' || type === 'json') content.push({ type, label, json: value });
    else content.push({ type, label, text: type === 'output' ? stringifyToolPayload(value) : stringifyToolValue(value) });
}

export function normalizeToolContentFromUpdate(update: Record<string, unknown>): ToolContent[] {
    const normalized: ToolContent[] = [];
    const rawContent = update['content'];
    if (Array.isArray(rawContent)) {
        for (const item of rawContent) {
            const content = normalizeToolContentItem(item);
            if (content) normalized.push(content);
        }
    } else {
        const content = normalizeToolContentItem(rawContent);
        if (content) normalized.push(content);
    }
    pushToolFieldContent(normalized, 'args', 'Args', update['args'] ?? update['arguments'] ?? update['input'] ?? update['rawInput']);
    pushToolFieldContent(normalized, 'output', 'Output', update['rawOutput'] ?? update['output']);
    pushToolFieldContent(normalized, 'error', 'Error', update['error'] ?? update['errorMessage'] ?? update['reason']);
    return normalized;
}

const POPUP_COMMANDS: Record<string, { category: CodeCommandCategory; popupKind: CodeCommandPopupKind }> = {
    settings: { category: 'settings', popupKind: 'settings' },
    theme: { category: 'settings', popupKind: 'settings' },
    identity: { category: 'settings', popupKind: 'settings' },
    'identity-auto': { category: 'settings', popupKind: 'settings' },
    model: { category: 'model', popupKind: 'model' },
    provider: { category: 'provider', popupKind: 'provider' },
    login: { category: 'provider', popupKind: 'provider' },
};

const CATEGORY_BY_NAME: Record<string, CodeCommandCategory> = {
    session: 'session',
    orchestrate: 'workflow',
    pabcd: 'workflow',
    goal: 'workflow',
    mcp: 'utility',
    move: 'utility',
    compact: 'utility',
    dump: 'utility',
    help: 'utility',
};

function stripSlash(name: string): string {
    return name.trim().replace(/^\/+/, '');
}

function commandSource(raw: Record<string, unknown>, name: string): CodeCommandSource {
    const source = typeof raw['source'] === 'string' ? raw['source'] : '';
    const path = typeof raw['path'] === 'string' ? raw['path'] : '';
    if (source.includes('skill') || name.includes(':')) return 'jwc-skill';
    if (source.includes('custom')) return 'jwc-custom';
    if (source.includes('file') || path) return 'jwc-file';
    if (POPUP_COMMANDS[name] || CATEGORY_BY_NAME[name]) return 'jwc-builtin';
    return 'unknown';
}

function inputHint(raw: Record<string, unknown>): string | undefined {
    const input = raw['input'];
    if (!input || typeof input !== 'object') return undefined;
    const hint = (input as Record<string, unknown>)['hint'];
    return typeof hint === 'string' && hint.trim() ? hint : undefined;
}

export function normalizeCodeCommand(raw: unknown): CodeCommand | null {
    if (!raw || typeof raw !== 'object') return null;
    const record = raw as Record<string, unknown>;
    const normalizedName = stripSlash(String(record['name'] ?? ''));
    if (!normalizedName) return null;

    const popup = POPUP_COMMANDS[normalizedName];
    const category = popup?.category ?? CATEGORY_BY_NAME[normalizedName] ?? 'unknown';
    const source = commandSource(record, normalizedName);
    const supported = record['supported'] !== false && record['disabled'] !== true;
    const actionType: CodeCommandActionType = !supported ? 'unsupported' : popup ? 'popup' : category === 'unknown' ? 'pass-through' : 'insert';
    const description = typeof record['description'] === 'string' && record['description'].trim()
        ? record['description']
        : undefined;
    const hint = inputHint(record);
    const command: CodeCommand = {
        name: normalizedName,
        displayName: `/${normalizedName}`,
        category,
        actionType,
        source,
        raw: record,
    };
    if (description) command.description = description;
    if (hint) command.inputHint = hint;
    if (popup) command.popupKind = popup.popupKind;
    if (actionType === 'unsupported') {
        command.disabledReason = typeof record['disabledReason'] === 'string' && record['disabledReason'].trim()
            ? record['disabledReason']
            : 'Unsupported in Code mode';
    }
    return command;
}

export function normalizeCodeCommands(rawCommands: unknown): CodeCommand[] {
    const commands = Array.isArray(rawCommands) ? rawCommands : [];
    const seen = new Set<string>();
    const normalized: CodeCommand[] = [];
    for (const raw of commands) {
        const command = normalizeCodeCommand(raw);
        if (!command || seen.has(command.name)) continue;
        seen.add(command.name);
        normalized.push(command);
    }
    return normalized;
}

function searchableCommandText(command: CodeCommand): string {
    return [
        command.name,
        command.displayName,
        command.description ?? '',
        command.inputHint ?? '',
        command.category,
        command.source,
    ].join(' ').toLowerCase();
}

export function filterCodeCommands(commands: CodeCommand[], inputText: string): CodeCommand[] {
    const query = stripSlash(inputText.split(/\s+/)[0] ?? '').toLowerCase();
    if (!query) return commands;
    const prefixMatches: CodeCommand[] = [];
    const fuzzyMatches: CodeCommand[] = [];
    for (const command of commands) {
        if (command.name.toLowerCase().startsWith(query)) {
            prefixMatches.push(command);
        } else if (searchableCommandText(command).includes(query)) {
            fuzzyMatches.push(command);
        }
    }
    return [...prefixMatches, ...fuzzyMatches];
}
