import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyActivityTool, isActivityFileEdit, groupActivityEntries } from '../../src/shared/activity-kind.ts';
import type { ActivityEntry } from '../../src/shared/activity-state.ts';
const id = { version: 1 as const, sessionId: 's', scope: 's', runId: 'r', turnId: 't', seq: 1 };
const tool = (itemId: string, name: string): ActivityEntry => ({ ...id, kind: 'tool', itemId, name, status: 'done' });
test('ordered kind rules handle namespace, camel case and negative substrings', () => {
    for (const [kind, names] of Object.entries({
        mcp: ['mcp__fs__read', 'mcpSearch', 'mcp__exec', 'mcp__cat', 'mcp__patch'], command: ['bash', 'shell', 'functions.exec_command', 'runCommand', 'terminal', 'exec_read', 'exec_cat', 'shell_patch'],
        file: ['ReadFile', 'write_file', 'edit', 'apply_patch', 'create', 'view', 'cat', 'catFile', 'patch', 'patchFile', 'read_patch', 'read a.ts', 'read_search'],
        search: ['grep', 'glob', 'rg', 'web.search', 'find', 'listFiles'], other: ['', 'preview', 'runner', 'researcher', 'catch', 'dispatch', 'customTool'],
    })) for (const name of names) assert.equal(classifyActivityTool(name), kind, name);
});
test('adjacent pairs group; reasoning/message and different kind split; original entries survive', () => {
    const thought: ActivityEntry = { ...id, kind: 'reasoning', itemId: 'q', text: 'Thinking', operation: 'replace' };
    const message: ActivityEntry = { ...id, kind: 'message', itemId: 'm', phase: 'commentary', text: 'Note', operation: 'replace' };
    const entries = [tool('a', 'bash'), tool('b', 'exec'), thought, tool('c', 'bash'), message, tool('d', 'read')];
    const units = groupActivityEntries(entries); assert.deepEqual(units.map(unit => unit.type), ['group', 'row', 'row', 'row', 'row']);
    const flattened = units.flatMap(unit => unit.type === 'group' ? unit.entries : [unit.entry]);
    flattened.forEach((entry, i) => assert.equal(entry, entries[i])); assert.deepEqual(groupActivityEntries([]), []);
});
test('R-05 file verbs share read/edit classification and mixed groups keep order', () => {
    const reads = ['read', 'ReadFile', 'view', 'view_file', 'cat', 'catFile'];
    const edits = ['write', 'WriteFile', 'edit', 'patch', 'PatchFile', 'apply_patch', 'create', 'read_patch'];
    for (const name of [...reads, ...edits]) {
        assert.equal(classifyActivityTool(name), 'file', name);
        assert.equal(isActivityFileEdit(name), edits.includes(name), name);
    }
    for (const [names, label] of [
        [reads, 'Read 6 files'], [edits, 'Edited 8 files'],
        [['cat', 'patch'], 'Worked on 2 files'],
        [['apply_patch', 'view'], 'Worked on 2 files'],
    ] as const) {
        const entries = names.map((name, i) => tool(String(i), name));
        const [unit] = groupActivityEntries(entries);
        assert.ok(unit && unit.type === 'group');
        assert.equal(unit.label, label);
        unit.entries.forEach((entry, i) => assert.equal(entry, entries[i]));
    }
    const pair = [tool('a', 'cat'), tool('b', 'view')];
    const original = groupActivityEntries(pair)[0]!;
    const mixed = groupActivityEntries([...pair, tool('c', 'patch')])[0]!;
    assert.ok(original.type === 'group' && mixed.type === 'group');
    assert.equal(mixed.key, original.key);
    assert.equal(mixed.label, 'Worked on 3 files');
});
test('all five kinds expose exact count labels and append-stable first-item keys', () => {
    for (const [name, label] of [['bash', 'Ran 2 commands'], ['edit', 'Edited 2 files'], ['grep', 'Searched 2 times'], ['mcp__x', 'Called 2 tools'], ['custom', 'Called 2 tools']]) {
        const pair = [tool('a', name!), tool('b', name!)], unit = groupActivityEntries(pair)[0]!;
        assert.equal(unit.type, 'group'); if (unit.type !== 'group') throw new Error('Expected group');
        assert.equal(unit.label, label);
        const grown = groupActivityEntries([...pair, tool('c', name!)])[0]!;
        assert.equal(grown.type, 'group'); if (grown.type === 'group') assert.equal(grown.key, unit.key);
    }
});
