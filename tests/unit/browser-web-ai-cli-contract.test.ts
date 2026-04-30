import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliSrc = fs.readFileSync(join(root, 'bin/commands/browser.ts'), 'utf8');
const cliWebAiSrc = fs.readFileSync(join(root, 'bin/commands/browser-web-ai.ts'), 'utf8');
const routeSrc = fs.readFileSync(join(root, 'src/routes/browser.ts'), 'utf8');
const indexSrc = fs.readFileSync(join(root, 'src/browser/index.ts'), 'utf8');

test('BWCLI-001: CLI exposes closed web-ai command surface', () => {
    assert.match(cliWebAiSrc, /const WEB_AI_COMMANDS = new Set\(\['render', 'status', 'send', 'poll', 'query', 'watch', 'watchers', 'sessions', 'notifications', 'capabilities', 'stop', 'diagnose', 'context-dry-run', 'context-render'\]\)/);
    assert.match(cliSrc, /case 'web-ai'/);
    assert.match(cliSrc, /runWebAiCommand/);
});

test('BWCLI-002: send and query gating + flag rejection (32.7B live)', () => {
    assert.match(cliWebAiSrc, /require --inline-only or --file/);
    assert.match(cliWebAiSrc, /isSupportedWebAiModel/);
    assert.match(cliWebAiSrc, /gemini: new Set/);
    assert.match(cliWebAiSrc, /grok: new Set/);
});

test('BWCLI-003: web-ai routes are authenticated', () => {
    for (const route of ['render', 'context-dry-run', 'context-render', 'status', 'send', 'poll', 'watch', 'watchers', 'sessions', 'notifications', 'capabilities', 'query', 'stop', 'diagnose']) {
        assert.match(routeSrc, new RegExp(`/api/browser/web-ai/${route}', requireAuth`));
    }
});

test('BWCLI-005: web-ai CLI supports durable watcher commands and URL reattach', () => {
    assert.match(cliWebAiSrc, /url: \{ type: 'string' \}/);
    assert.match(cliWebAiSrc, /notify: \{ type: 'boolean', default: true \}/);
    assert.match(cliWebAiSrc, /if \(command === 'sessions'\)/);
    assert.match(cliWebAiSrc, /if \(command === 'notifications'\)/);
    assert.match(cliWebAiSrc, /if \(command === 'watchers'\)/);
    assert.match(cliWebAiSrc, /if \(command === 'capabilities'\)/);
    assert.match(cliWebAiSrc, /if \(command === 'watch'\)/);
    assert.match(cliWebAiSrc, /'poll-interval': \{ type: 'string' \}/);
    assert.match(routeSrc, /\/api\/browser\/web-ai\/watch', requireAuth/);
    assert.match(routeSrc, /req\.query\.url/);
    assert.match(routeSrc, /req\.query\.notify/);
    assert.match(routeSrc, /req\.query\.pollIntervalSeconds/);
    assert.match(routeSrc, /\/api\/browser\/web-ai\/watchers', requireAuth/);
    assert.match(routeSrc, /\/api\/browser\/web-ai\/sessions', requireAuth/);
    assert.match(routeSrc, /\/api\/browser\/web-ai\/notifications', requireAuth/);
    assert.match(routeSrc, /\/api\/browser\/web-ai\/capabilities', requireAuth/);
});

test('BWCLI-006: web-ai CLI exposes Oracle-style context packaging flags', () => {
    assert.match(cliWebAiSrc, /'context-from-files': \{ type: 'string', multiple: true \}/);
    assert.match(cliWebAiSrc, /'context-exclude': \{ type: 'string', multiple: true \}/);
    assert.match(cliWebAiSrc, /'context-file': \{ type: 'string' \}/);
    assert.match(cliWebAiSrc, /'max-input': \{ type: 'string' \}/);
    assert.match(cliWebAiSrc, /'context-transport': \{ type: 'string' \}/);
    assert.match(cliWebAiSrc, /hasContextPackage/);
    assert.match(cliWebAiSrc, /renderContextDryRunReport/);
    assert.match(routeSrc, /\/api\/browser\/web-ai\/context-dry-run', requireAuth/);
    assert.match(routeSrc, /\/api\/browser\/web-ai\/context-render', requireAuth/);
});

test('BWCLI-007: copy-markdown fallback flag is wired through CLI and routes', () => {
    assert.match(cliWebAiSrc, /'allow-copy-markdown-fallback': \{ type: 'boolean', default: false \}/);
    assert.match(cliWebAiSrc, /allowCopyMarkdownFallback: true/);
    assert.match(routeSrc, /allowCopyMarkdownFallback === 'true'/);
});

test('BWCLI-004: browser index exports webAi namespace', () => {
    assert.match(indexSrc, /export \* as webAi from '\.\/web-ai\/index\.js'/);
    assert.match(indexSrc, /export type \* from '\.\/web-ai\/index\.js'/);
});
