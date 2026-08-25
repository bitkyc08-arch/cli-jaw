// #442: --mutable must actually change what the employee is told.
//
// The override is a string replace against employee.md. When that template was
// reworded the pattern kept matching the OLD sentence, so the replace silently
// did nothing and a Boss who granted writes still handed the employee a prompt
// saying writes were blocked. A source-level regex test would not have caught it
// either — only comparing the two rendered prompts does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getEmployeePromptV2, clearPromptCache } from '../../src/prompt/builder.ts';

const emp = { name: 'reviewer', role: 'reviewer', id: 1 };

test('EMP-442a: --mutable removes the write-blocked line', () => {
    clearPromptCache();
    const readOnly = String(getEmployeePromptV2(emp, 'reviewer', 1, {}));
    clearPromptCache();
    const mutable = String(getEmployeePromptV2(emp, 'reviewer', 1, { mutable: true }));

    assert.match(readOnly, /File writes are blocked/,
        'the read-only prompt must state the restriction');
    assert.doesNotMatch(mutable, /File writes are blocked/,
        'granting --mutable must not leave the employee reading a blanket prohibition');
    assert.match(mutable, /authorized to create or modify files/);
});

test('EMP-442b: a scope is named in the authorization when one is given', () => {
    clearPromptCache();
    const scoped = String(getEmployeePromptV2(emp, 'reviewer', 1, { mutable: true, scope: 'src/messaging' }));
    assert.match(scoped, /inside `src\/messaging`/);
});

