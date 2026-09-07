import { activityEntryLabel, activityEntryText, type ActivityEntry } from '../../../src/shared/activity-state.js';
import { classifyActivityTool, isActivityFileEdit, type ActivityRenderGroup, type ActivityToolKind } from '../../../src/shared/activity-kind.js';
import { hydrateIcons, type IconName } from '../icons.js';
const glyphs: Record<ActivityToolKind, IconName> = { command: 'terminal', file: 'file', search: 'search', mcp: 'plug', other: 'tool' };
function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls: string) {
    const node = doc.createElement(tag); node.className = cls; return node; }
function text(node: Element, value: string) { if (node.textContent !== value) node.textContent = value; }
function glyph(node: HTMLElement, name: IconName) {
    if (node.dataset['icon'] === name) return;
    node.dataset['icon'] = name; node.setAttribute('aria-hidden', 'true');
    hydrateIcons(node.parentElement!); }
export function createActivityRow(doc: Document, id: string): HTMLDetailsElement {
    const row = el(doc, 'details', 'activity-item activity-row'); row.dataset['activityItemId'] = id;
    const head = el(doc, 'summary', 'activity-item-summary');
    head.append(el(doc, 'span', 'activity-row-icon'), el(doc, 'span', 'activity-row-label'),
        el(doc, 'span', 'activity-row-status'), el(doc, 'span', 'activity-chevron-sm'));
    const body = el(doc, 'pre', 'activity-item-text'); body.tabIndex = 0; body.setAttribute('aria-label', 'Activity preview');
    row.append(head, body); glyph(head.lastElementChild as HTMLElement, 'chevronDown'); return row; }
export function updateActivityRow(row: HTMLDetailsElement, entry: ActivityEntry, limit: number): void {
    const kind = entry.kind === 'tool' ? classifyActivityTool(entry.name) : entry.kind;
    row.className = `activity-item activity-row${entry.kind === 'tool' ? '' : ` activity-row-${entry.kind}`}`;
    row.dataset['kind'] = kind; row.dataset['status'] = entry.kind === 'tool' ? entry.status : '';
    const head = row.querySelector('summary')!; head.setAttribute('aria-label', activityEntryLabel(entry));
    glyph(head.querySelector<HTMLElement>('.activity-row-icon')!, entry.kind === 'tool' ? glyphs[classifyActivityTool(entry.name)]
        : entry.kind === 'reasoning' ? 'brain' : 'thinking');
    let label = activityEntryLabel(entry), status = '';
    if (entry.kind === 'tool') {
        const edit = kind === 'file' && isActivityFileEdit(entry.name);
        const past = kind === 'command' ? 'Ran' : kind === 'file' ? edit ? 'Edited' : 'Read' : kind === 'search' ? 'Searched' : 'Called';
        const active = kind === 'command' ? 'Running' : kind === 'file' ? edit ? 'Editing' : 'Reading' : kind === 'search' ? 'Searching' : 'Calling';
        const verb = entry.status === 'done' ? past : entry.status === 'running' ? active : entry.status === 'error' ? 'Failed' : 'Stopped';
        const first = (entry.input ?? '').split(/\r?\n/, 1)[0]!.trim() || entry.name;
        label = `${verb} ${first}`; status = entry.status === 'error' ? 'failed' : entry.status === 'done' ? '' : entry.status;
    }
    text(head.querySelector('.activity-row-label')!, label);
    const state = head.querySelector<HTMLElement>('.activity-row-status')!;
    text(state, status); state.setAttribute('aria-label', status === 'failed' ? 'Tool call failed' : status);
    const full = activityEntryText(entry);
    text(row.querySelector('pre')!, full.length > limit ? `${full.slice(0, limit)}\n[Preview limited; some text is omitted]` : full);
}
export function createActivityRows(doc: Document, list: HTMLElement) {
    const groups = new Map<string, { root: HTMLDivElement; head: HTMLButtonElement; body: HTMLDivElement }>();
    function place(parent: HTMLElement, node: HTMLElement, index: number) {
        if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] ?? null);
    }
    return {
        render(units: readonly ActivityRenderGroup[], rowFor: (entry: ActivityEntry) => HTMLDetailsElement) {
            const wanted = new Set<string>();
            units.forEach((unit, index) => {
                if (unit.type === 'row') { place(list, rowFor(unit.entry), index); return; }
                wanted.add(unit.key); let group = groups.get(unit.key);
                if (!group) {
                    const root = el(doc, 'div', 'activity-group'), head = el(doc, 'button', 'activity-group-summary');
                    const body = el(doc, 'div', 'activity-group-body'); head.type = 'button';
                    head.setAttribute('aria-expanded', 'true');
                    head.append(el(doc, 'span', 'activity-row-icon'), el(doc, 'span', 'activity-row-label'), el(doc, 'span', 'activity-chevron-sm'));
                    body.tabIndex = 0; body.setAttribute('role', 'region'); body.setAttribute('aria-label', 'Tool calls');
                    root.append(head, body); root.dataset['kind'] = unit.kind;
                    glyph(head.firstElementChild as HTMLElement, glyphs[unit.kind]); glyph(head.lastElementChild as HTMLElement, 'chevronDown');
                    head.onclick = () => { body.hidden = !body.hidden; head.setAttribute('aria-expanded', String(!body.hidden)); };
                    group = { root, head, body }; groups.set(unit.key, group);
                }
                const state = ['error', 'stopped', 'running'].find(s => unit.entries.some(entry => entry.status === s));
                const noun = unit.kind === 'command' ? 'commands' : unit.kind === 'file' ? 'files' : unit.kind === 'search' ? 'searches' : 'tools';
                text(group.head.querySelector('.activity-row-label')!, state ? `${unit.entries.length} ${noun} · ${state === 'error' ? 'failed' : state}` : unit.label);
                place(list, group.root, index);
                unit.entries.forEach((entry, i) => place(group!.body, rowFor(entry), i));
            });
            // Reparent surviving item nodes BEFORE removing obsolete wrappers.
            for (const [key, group] of groups) if (!wanted.has(key)) {
                group.head.onclick = null; group.root.remove(); groups.delete(key);
            }
        },
        dispose() { for (const group of groups.values()) group.head.onclick = null; groups.clear(); },
    };
}
