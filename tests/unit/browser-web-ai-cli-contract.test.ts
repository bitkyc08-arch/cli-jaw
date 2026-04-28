import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliSrc = fs.readFileSync(join(root, 'bin/commands/browser.ts'), 'utf8');
const routeSrc = fs.readFileSync(join(root, 'src/routes/browser.ts'), 'utf8');
const indexSrc = fs.readFileSync(join(root, 'src/browser/index.ts'), 'utf8');

test('BWCLI-001: CLI exposes closed web-ai command surface', () => {
    assert.match(cliSrc, /const WEB_AI_COMMANDS = new Set\(\['render', 'status', 'send', 'poll', 'query', 'stop'\]\)/);
    assert.match(cliSrc, /case 'web-ai'/);
    assert.match(cliSrc, /runWebAiCommand/);
});

test('BWCLI-002: send and query require inline-only', () => {
    assert.match(cliSrc, /send\/query require --inline-only/);
    assert.match(cliSrc, /--file is future scope/);
    assert.match(cliSrc, /--model is future scope/);
    assert.match(cliSrc, /--thinking-time is future scope/);
});

test('BWCLI-003: web-ai routes are authenticated', () => {
    for (const route of ['render', 'status', 'send', 'poll', 'query', 'stop']) {
        assert.match(routeSrc, new RegExp(`/api/browser/web-ai/${route}', requireAuth`));
    }
});

test('BWCLI-004: browser index exports webAi namespace', () => {
    assert.match(indexSrc, /export \* as webAi from '\.\/web-ai\/index\.js'/);
    assert.match(indexSrc, /export type \* from '\.\/web-ai\/index\.js'/);
});
