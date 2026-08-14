import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSource } from './source-normalize.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliSrc = readSource(join(root, 'bin/commands/browser.ts'), 'utf8');
const cliWebAiSrc = readSource(join(root, 'bin/commands/browser-web-ai.ts'), 'utf8');
const routeSrc = readSource(join(root, 'src/routes/browser.ts'), 'utf8');
const indexSrc = readSource(join(root, 'src/browser/index.ts'), 'utf8');

test('BWCLI-001: CLI exposes closed web-ai command surface', () => {
    assert.match(cliWebAiSrc, /const WEB_AI_COMMANDS = new Set\(\['render', 'status', 'send', 'poll', 'query', 'watch', 'watchers', 'sessions', 'sessions-prune', 'resume', 'reattach', 'notifications', 'capabilities', 'stop', 'diagnose', 'doctor', 'context-dry-run', 'context-render', 'code', 'code-extract'\]\)/);
    assert.match(cliSrc, /case 'web-ai'/);
    assert.match(cliSrc, /runWebAiCommand/);
});

test('BWCLI-002: send and query gating + flag rejection (32.7B live)', () => {
    assert.match(cliWebAiSrc, /require --inline-only or --file/);
    assert.match(cliWebAiSrc, /isSupportedWebAiModel/);
    assert.match(cliWebAiSrc, /gemini: new Set/);
    assert.match(cliWebAiSrc, /deepthink/);
    assert.match(cliWebAiSrc, /grok: new Set/);
    assert.match(cliWebAiSrc, /WEB_AI_USAGE/);
    assert.match(cliWebAiSrc, /--effort <alias>/);
    assert.match(cliWebAiSrc, /Requires --model/);
    assert.match(cliWebAiSrc, /Force a fresh provider tab/);
    assert.match(cliWebAiSrc, /default reuses pooled or inactive tabs first/);
    assert.match(cliWebAiSrc, /--require-source-audit/);
    assert.match(cliWebAiSrc, /--source-audit-ratio <0\.\.1>/);
    assert.match(cliWebAiSrc, /--source-audit-scope <text>/);
    assert.match(cliWebAiSrc, /--source-audit-date <text>/);
    assert.match(cliWebAiSrc, /Code artifacts:/);
    assert.match(cliWebAiSrc, /Automatically uploads the\s+saved GPT dev-agent context zip first/);
    assert.match(cliWebAiSrc, /requires PLAN\.md\s+or 00_plan\.md/);
    assert.match(cliWebAiSrc, /WEB_AI_CODE_USAGE/);
    assert.match(cliWebAiSrc, /subcommand, not a --code flag/);
    assert.match(cliWebAiSrc, /cli-jaw browser web-ai code --vendor chatgpt --model thinking --effort standard/);
    assert.match(cliWebAiSrc, /visible turn_plan\.update_turn_plan checklist is best-effort/);
    assert.match(cliWebAiSrc, /usageForCommand\(command\)/);
    assert.match(cliWebAiSrc, /code-extract\s+Re-retrieve existing ChatGPT code-mode zip artifacts/);
    assert.match(cliWebAiSrc, /WEB_AI_CODE_EXTRACT_USAGE/);
    assert.match(cliWebAiSrc, /It does not send a new prompt/);
    assert.match(cliWebAiSrc, /A copied \/mnt\/data\/result\.zip text line alone is not enough/);
});

test('BWCLI-003: web-ai routes are authenticated', () => {
    for (const route of ['render', 'context-dry-run', 'context-render', 'status', 'send', 'poll', 'watch', 'watchers', 'sessions', 'notifications', 'capabilities', 'query', 'code', 'code-extract', 'stop', 'diagnose']) {
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

test('BWCLI-006: web-ai CLI exposes context packaging flags', () => {
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

test('BWCLI-006b: web-ai CLI exposes code-mode artifact flags and repeatable uploads', () => {
    assert.match(cliWebAiSrc, /file: \{ type: 'string', multiple: true \}/);
    assert.match(cliWebAiSrc, /const filePaths = \(Array\.isArray\(values\.file\)/);
    assert.match(cliWebAiSrc, /\.\.\.\(filePaths\.length \? \{ filePath: filePaths\[0\], filePaths \} : \{\}\)/);
    assert.match(cliWebAiSrc, /'output-zip': \{ type: 'string' \}/);
    assert.match(cliWebAiSrc, /'output-dir': \{ type: 'string' \}/);
    assert.match(cliWebAiSrc, /'multi-zip': \{ type: 'boolean', default: false \}/);
    assert.match(cliWebAiSrc, /conversation: \{ type: 'string' \}/);
    assert.match(cliWebAiSrc, /if \(command === 'context-dry-run' \|\| command === 'context-render'\)/);
    assert.match(cliWebAiSrc, /return deps\.api\('POST', `\/web-ai\/\$\{command\}`, body\)/);
});

test('BWCLI-007: copy-markdown fallback flag is wired through CLI and routes', () => {
    assert.match(cliWebAiSrc, /'allow-copy-markdown-fallback': \{ type: 'boolean', default: false \}/);
    assert.match(cliWebAiSrc, /Explicitly permit provider Copy button capture; no OS clipboard read/);
    assert.match(cliSrc, /Explicitly permit provider Copy button capture; no OS clipboard read/);
    assert.match(cliWebAiSrc, /allowCopyMarkdownFallback: true/);
    assert.match(routeSrc, /allowCopyMarkdownFallback === 'true'/);
});

test('BWCLI-008: source audit flags are wired through CLI and routes', () => {
    assert.match(cliWebAiSrc, /'require-source-audit': \{ type: 'boolean', default: false \}/);
    assert.match(cliWebAiSrc, /sourceAuditRatio: values\['source-audit-ratio'\]/);
    assert.match(cliWebAiSrc, /sourceAuditScope: values\['source-audit-scope'\]/);
    assert.match(cliWebAiSrc, /sourceAuditDate: values\['source-audit-date'\]/);
    assert.match(routeSrc, /requireSourceAudit: true/);
    assert.match(routeSrc, /sourceAuditRatio: String\(req\.query\.sourceAuditRatio\)/);
});

test('BWCLI-004: browser index exports webAi namespace', () => {
    assert.match(indexSrc, /export \* as webAi from '\.\/web-ai\/index\.js'/);
    assert.match(indexSrc, /export type \* from '\.\/web-ai\/index\.js'/);
});

test('BWCLI-009: cli-jaw skill documents native code artifact generation and extraction', () => {
    const skillPath = join(root, 'skills_ref/web-ai/SKILL.md');
    if (!fs.existsSync(skillPath)) {
        return; // skills_ref submodule not initialized (e.g. promotion worktree)
    }
    const skillSrc = readSource(skillPath, 'utf8');
    assert.match(skillSrc, /ChatGPT Code Artifact Extraction/);
    assert.match(skillSrc, /cli-jaw browser web-ai code/);
    assert.match(skillSrc, /gpt-dev-agent-context\.zip/);
    assert.match(skillSrc, /PLAN\.md|00_plan\.md/);
    assert.match(skillSrc, /cli-jaw browser web-ai code-extract/);
});
