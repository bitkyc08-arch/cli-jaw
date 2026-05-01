import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('STATUS-CAP-001: src/browser/web-ai/chatgpt.ts status() embeds capabilities[] from listCapabilitySchemas', () => {
    const src = readFileSync(join(process.cwd(), 'src/browser/web-ai/chatgpt.ts'), 'utf8');
    assert.match(src, /import \{ listCapabilitySchemas \} from '\.\/capability-registry\.js'/);
    assert.match(src, /allRows = listCapabilitySchemas\(\{ vendor: vendor as any \}\)/);
    assert.match(src, /input\.probe\s*\?\s*allRows\.filter/);
    assert.match(src, /capabilities: rows/);
});

test('STATUS-CAP-002: status route forwards probe query param', () => {
    const src = readFileSync(join(process.cwd(), 'src/routes/browser.ts'), 'utf8');
    assert.match(src, /\/api\/browser\/web-ai\/status[\s\S]*req\.query\.probe \? \{ probe: String\(req\.query\.probe\) \}/);
});

test('STATUS-CAP-003: CLI status command adds probe query string', () => {
    const src = readFileSync(join(process.cwd(), 'bin/commands/browser-web-ai.ts'), 'utf8');
    assert.match(src, /command === 'status'.*probe: values\.probe/);
    assert.match(src, /probe: \{ type: 'string' \}/);
});
