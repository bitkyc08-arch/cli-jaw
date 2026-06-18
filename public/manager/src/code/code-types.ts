export type ToolContent = {
    type: 'args' | 'output' | 'error' | 'diff' | 'json' | 'text';
    label?: string;
    text?: string;
    diff?: string;
    json?: unknown;
    [key: string]: unknown;
};

export type TranscriptEntry = {
    role: 'user' | 'assistant' | 'tool' | 'thinking';
    text: string;
    toolName?: string;
    toolStatus?: string;
    toolCallId?: string;
    toolContent?: ToolContent[];
    toolOutput?: string;
};

export type PendingPermission = {
    permissionId: string;
    toolCall: Record<string, unknown>;
    options: Array<Record<string, unknown>>;
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

function stringifyToolValue(value: unknown): string {
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
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
    if (rawType === 'output') return { type: 'output', text: stringifyToolValue(record['text'] ?? record['output'] ?? record), ...(label ? { label } : {}) };
    if (rawType === 'json') return { type: 'json', json: record['json'] ?? record['value'] ?? record, ...(label ? { label } : {}) };
    if (typeof record['diff'] === 'string') return { type: 'diff', diff: record['diff'], ...(label ? { label } : {}) };
    if (typeof record['text'] === 'string') return { type: 'text', text: record['text'], ...(label ? { label } : {}) };
    return { type: 'json', json: record, ...(label ? { label } : {}) };
}

function pushToolFieldContent(content: ToolContent[], type: ToolContent['type'], label: string, value: unknown): void {
    if (value === undefined || value === null || value === '') return;
    if (type === 'args' || type === 'json') content.push({ type, label, json: value });
    else content.push({ type, label, text: stringifyToolValue(value) });
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
