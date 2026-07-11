export interface SlashCommand {
    name: string;
    desc?: string;
    args?: string | null;
    aliases?: string[];
}

export interface SlashMatch {
    query: string;
    start: number;
}

export function slashMatch(value: string, caret = value.length): SlashMatch | null {
    const before = value.slice(0, caret);
    const start = before.lastIndexOf('/');
    if (start < 0 || (start > 0 && !/\s/.test(before[start - 1] ?? ''))) return null;
    const token = before.slice(start);
    if (/^\/(?:[^\s/]*\/|(?:tmp|home|Users|var|etc|opt|usr)\/)/i.test(token)) return null;
    if (/\s/.test(token)) return null;
    return { query: token.slice(1).toLowerCase(), start };
}

export function filterSlashCommands(commands: readonly SlashCommand[], match: SlashMatch | null): SlashCommand[] {
    if (!match) return [];
    return commands.filter(command => {
        const names = [command.name, ...(command.aliases ?? [])].map(name => name.replace(/^\//, '').toLowerCase());
        return names.some(name => name.startsWith(match.query));
    });
}

export function applySlashCommand(value: string, command: SlashCommand, match: SlashMatch): string {
    const name = command.name.startsWith('/') ? command.name : `/${command.name}`;
    return `${value.slice(0, match.start)}${name}${command.args ? ' ' : ''}`;
}

export function moveMenuIndex(current: number, direction: 1 | -1, count: number): number {
    if (count <= 0) return -1;
    return (current + direction + count) % count;
}
