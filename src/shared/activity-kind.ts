import type { ActivityEntry } from './activity-state.js';
export type ActivityToolKind = 'command' | 'file' | 'search' | 'mcp' | 'other';
type Tool = Extract<ActivityEntry, { kind: 'tool' }>;
export type ActivityRenderGroup =
    | { type: 'row'; entry: ActivityEntry }
    | { type: 'group'; key: string; kind: ActivityToolKind; label: string; entries: Tool[] };
function normalizedToolName(name: string): string {
    return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}
// Callers use this predicate only after classifying a tool as file.
export function isActivityFileEdit(name: string): boolean {
    return /(^|[\s_.:/-])(write|edit|apply_patch|patch|create)(?=$|[\s_.:/-])/.test(normalizedToolName(name));
}
export function classifyActivityTool(name: string): ActivityToolKind {
    if (/__|mcp/i.test(name)) return 'mcp';
    const value = normalizedToolName(name);
    if (/(^|[\s_.:/-])(bash|shell|exec|run|command|terminal)(?=$|[\s_.:/-])/.test(value)) return 'command';
    if (/(^|[\s_.:/-])(read|view|cat|write|edit|apply_patch|patch|create)(?=$|[\s_.:/-])/.test(value)) return 'file';
    if (/(^|[\s_.:/-])(grep|glob|rg|search|find|list)(?=$|[\s_.:/-])/.test(value)) return 'search';
    return 'other'; }
export function groupActivityEntries(entries: readonly ActivityEntry[]): ActivityRenderGroup[] {
    const result: ActivityRenderGroup[] = [];
    let pending: Tool[] = [], kind: ActivityToolKind = 'other';
    const flush = () => {
        const first = pending[0]; if (!first) return;
        if (pending.length === 1) result.push({ type: 'row', entry: first });
        else {
            const n = pending.length;
            const edited = kind === 'file' ? pending.filter(entry => isActivityFileEdit(entry.name)).length : 0;
            const fileVerb = edited === 0 ? 'Read' : edited === n ? 'Edited' : 'Worked on';
            const label = kind === 'command' ? `Ran ${n} commands` : kind === 'file' ? `${fileVerb} ${n} files`
                : kind === 'search' ? `Searched ${n} times` : `Called ${n} tools`;
            result.push({ type: 'group', key: JSON.stringify([kind, first.itemId]), kind, label, entries: pending });
        }
        pending = [];
    };
    for (const entry of entries) {
        if (entry.kind !== 'tool') { flush(); result.push({ type: 'row', entry }); continue; }
        const next = classifyActivityTool(entry.name); if (pending.length && next !== kind) flush();
        kind = next; pending.push(entry);
    }
    flush(); return result; }
