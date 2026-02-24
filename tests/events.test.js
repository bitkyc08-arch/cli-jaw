import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractToolLabelsForTest } from '../src/events.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readFixture(name) {
    const fixturePath = path.join(__dirname, 'fixtures', name);
    return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
}

test('claude stream_event tool labels are deduped', () => {
    const ctx = { seenToolKeys: new Set(), hasClaudeStreamEvents: false };
    const evt = readFixture('claude-stream-tool.json');

    const first = extractToolLabelsForTest('claude', evt, ctx);
    const second = extractToolLabelsForTest('claude', evt, ctx);

    assert.deepEqual(first, [{ icon: '🔧', label: 'Bash' }]);
    assert.equal(second.length, 0);
    assert.equal(ctx.hasClaudeStreamEvents, true);
});

test('claude assistant fallback works when stream was not seen', () => {
    const ctx = { seenToolKeys: new Set(), hasClaudeStreamEvents: false };
    const evt = readFixture('claude-assistant-tool.json');

    const labels = extractToolLabelsForTest('claude', evt, ctx);
    assert.deepEqual(labels, [{ icon: '🔧', label: 'Read' }]);
});

test('claude assistant blocks are ignored after stream event', () => {
    const ctx = { seenToolKeys: new Set(), hasClaudeStreamEvents: true };
    const evt = readFixture('claude-assistant-tool.json');

    const labels = extractToolLabelsForTest('claude', evt, ctx);
    assert.equal(labels.length, 0);
});
