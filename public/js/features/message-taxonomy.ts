export type MessageDisplayRole = 'user' | 'agent' | 'system';

export interface MessageTaxonomyInput {
    role?: string | null;
    source?: string | null;
    kind?: string | null;
    cli?: string | null;
    external?: boolean;
    fromQueue?: boolean;
}

const SYSTEM_SOURCES = new Set(['bgtask', 'goal', 'system']);
const SYSTEM_KINDS = new Set(['bgtask', 'goal', 'notification', 'system', 'system_notice']);
const SYSTEM_CLIS = new Set(['bgtask', 'goal', 'goal_boundary', 'goal_continuation', 'system']);

function normalize(value: string | null | undefined): string {
    return String(value || '').trim().toLowerCase();
}

export function classifyMessageDisplayRole(message: MessageTaxonomyInput): MessageDisplayRole {
    const role = normalize(message.role);
    if (role === 'assistant' || role === 'agent') return 'agent';
    if (role === 'system') return 'system';

    if (SYSTEM_KINDS.has(normalize(message.kind))) return 'system';
    if (SYSTEM_SOURCES.has(normalize(message.source))) return 'system';
    if (SYSTEM_CLIS.has(normalize(message.cli))) return 'system';

    return 'user';
}
