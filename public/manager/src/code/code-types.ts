export type ToolContent = { type: string; text?: string; diff?: string; [key: string]: unknown };

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
