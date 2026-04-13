import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readSrc(rel: string): string {
    return fs.readFileSync(join(__dirname, rel), 'utf8');
}

test('prompt guard: system prompt contains delegation prohibition block', () => {
    const src = readSrc('../../src/prompt/builder.ts');
    assert.ok(src.includes('Delegation Rules'), 'should have Delegation Rules section');
    assert.ok(src.includes('Do NOT use Agent, subagent, or delegation tools.'));
});

test('prompt guard: prohibition covers forDisk and employee prompt paths', () => {
    const src = readSrc('../../src/prompt/builder.ts');
    const systemPromptSection = src.slice(src.indexOf('function getSystemPrompt'));
    const employeePromptSection = src.slice(src.indexOf('export function getEmployeePromptV2'));

    assert.ok(systemPromptSection.includes('opts.forDisk'));
    assert.ok(employeePromptSection.includes('Do NOT use Agent, subagent, or delegation tools. Do all work directly.'));
    assert.ok(src.includes('Delegation Rules'), 'builder should include Delegation Rules section');
});
