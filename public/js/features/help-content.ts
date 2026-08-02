// Contextual help topic registry. Keep this module data-only so tests can import it safely.

export type HelpTopicId =
    | 'activeCli'
    | 'model'
    | 'effort'
    | 'permissions'
    | 'flushAgent'
    | 'employees'
    | 'skills'
    | 'activeChannel'
    | 'telegram'
    | 'discord'
    | 'slack'
    | 'fallbackOrder'
    | 'mcp'
    | 'memory'
    | 'stt'
    | 'promptTemplates'
    | 'chatInput'
    | 'orchestration'
    | 'attachments'
    | 'diagrams'
    | 'keyboardShortcuts'
    | 'session'
    | 'cliTools'
    | 'agentControl'
    | 'goals';

export interface HelpDocLink {
    url: string;
    labelKey: string;
}

export interface HelpTopic {
    titleKey: string;
    introKey: string;
    effectKey: string;
    useWhenKeys: string[];
    howToKeys: string[];
    exampleKeys: string[];
    avoidWhenKeys?: string[];
    relatedKeys?: string[];
    subcmdKeys?: string[];
    docLinks?: HelpDocLink[];
}

export const HELP_TOPICS: Record<HelpTopicId, HelpTopic> = {
    activeCli: topic('activeCli', 2, 1, 2, 2, 1, 3),
    model: topic('model', 2, 1, 1, 2, 1, 2),
    effort: topic('effort', 2, 1, 1),
    permissions: topic('permissions', 2, 1, 1),
    flushAgent: topic('flushAgent', 2, 1, 1, 2, 1, 3),
    employees: topic('employees', 3, 3, 2, 4, 1, 2),
    skills: topic('skills', 2, 1, 1, 4, 1, 3),
    activeChannel: topic('activeChannel', 2, 1, 1),
    telegram: {
        ...topic('telegram', 2, 1, 2, 8),
        docLinks: [
            { url: 'https://t.me/BotFather', labelKey: 'help.telegram.link.botfather' },
            { url: 'https://core.telegram.org/bots/tutorial', labelKey: 'help.telegram.link.docs' },
        ],
    },
    discord: {
        ...topic('discord', 2, 1, 2, 9),
        docLinks: [
            { url: 'https://discord.com/developers/applications', labelKey: 'help.discord.link.portal' },
            { url: 'https://discord.com/developers/docs/getting-started', labelKey: 'help.discord.link.docs' },
        ],
    },
    slack: {
        ...topic('slack', 2, 1, 2, 9),
        docLinks: [
            { url: 'https://api.slack.com/apps', labelKey: 'help.slack.link.portal' },
            { url: 'https://docs.slack.dev/apis/events-api/using-socket-mode/', labelKey: 'help.slack.link.docs' },
        ],
    },
    fallbackOrder: topic('fallbackOrder', 2, 1, 1, 2, 1, 3),
    mcp: topic('mcp', 2, 1, 1, 4, 1, 5),
    memory: topic('memory', 2, 1, 2, 4, 1, 2),
    stt: topic('stt', 2, 1, 1),
    promptTemplates: topic('promptTemplates', 2, 1, 1),
    chatInput: topic('chatInput', 3, 2, 2),
    orchestration: topic('orchestration', 3, 2, 2, 8, 1, 8),
    attachments: topic('attachments', 3, 2, 2),
    diagrams: topic('diagrams', 3, 2, 2),
    keyboardShortcuts: topic('keyboardShortcuts', 3, 2, 2, 3, 2, 3),
    session: topic('session', 3, 1, 2, 8, 1, 9),
    cliTools: topic('cliTools', 3, 1, 2, 6, 1, 9),
    agentControl: topic('agentControl', 3, 1, 2, 6, 1, 6),
    goals: topic('goals', 3, 1, 2, 10, 1, 25),
};

export function isHelpTopicId(value: string | null | undefined): value is HelpTopicId {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(HELP_TOPICS, value);
}

function topic(
    id: HelpTopicId,
    useCount: number,
    avoidCount: number,
    relatedCount: number,
    howToCount = 2,
    exampleCount = 1,
    subcmdCount = 0,
): HelpTopic {
    return {
        titleKey: `help.${id}.title`,
        introKey: `help.${id}.intro`,
        effectKey: `help.${id}.effect`,
        useWhenKeys: rangeKeys(`help.${id}.use`, useCount),
        howToKeys: rangeKeys(`help.${id}.howTo`, howToCount),
        exampleKeys: rangeKeys(`help.${id}.example`, exampleCount),
        avoidWhenKeys: rangeKeys(`help.${id}.avoid`, avoidCount),
        relatedKeys: rangeKeys(`help.${id}.related`, relatedCount),
        ...(subcmdCount > 0 ? { subcmdKeys: rangeKeys(`help.${id}.subcmd`, subcmdCount) } : {}),
    };
}

function rangeKeys(prefix: string, count: number): string[] {
    return Array.from({ length: count }, (_, i) => `${prefix}.${i + 1}`);
}
