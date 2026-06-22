import { openHelpDialog } from './help-dialog.js';
import type { HelpTopicId } from './help-content.js';

export const COMMAND_TOPIC_MAP: Record<string, HelpTopicId> = {
    mcp: 'mcp',
    memory: 'memory',
    model: 'model',
    effort: 'effort',
    cli: 'activeCli',
    skill: 'skills',
    employee: 'employees',
    orchestrate: 'orchestration',
    pabcd: 'orchestration',
    flush: 'flushAgent',
    fallback: 'fallbackOrder',
    prompt: 'promptTemplates',
    browser: 'mcp',
    status: 'activeCli',
    steer: 'chatInput',
    clear: 'session',
    compact: 'session',
    reset: 'session',
    purge: 'session',
    new: 'session',
    switch: 'session',
    sw: 'session',
    sessions: 'session',
    ss: 'session',
    version: 'cliTools',
    project: 'cliTools',
    proj: 'cliTools',
    ide: 'cliTools',
    file: 'cliTools',
    forward: 'agentControl',
    thought: 'agentControl',
    goal: 'goals',
    goalplan: 'goals',
    gd: 'goals',
    plan: 'goals',
    interview: 'goals',
    deliberate: 'goals',
    planaudit: 'goals',
    review: 'goals',
    search: 'mcp',
    team: 'goals',
    task: 'goals',
    help: 'keyboardShortcuts',
    h: 'keyboardShortcuts',
    commands: 'keyboardShortcuts',
    cmd: 'keyboardShortcuts',
    fork: 'session',
    quit: 'session',
    q: 'session',
    exit: 'session',
    telegram: 'telegram',
    discord: 'discord',
    stt: 'stt',
    attachments: 'attachments',
    diagrams: 'diagrams',
};

export function tryCommandInfo(text: string): boolean {
    const trimmed = text.replace(/^\//, '').trim();
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2 || parts[parts.length - 1].toLowerCase() !== 'info') return false;

    const cmdName = parts[0].toLowerCase();
    const topicId = COMMAND_TOPIC_MAP[cmdName];
    if (!topicId) return false;

    openHelpDialog(topicId);
    return true;
}
