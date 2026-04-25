import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '../..');
const badgePath = join(root, 'public/js/features/attention-badge.ts');
const mainPath = join(root, 'public/js/main.ts');
const wsPath = join(root, 'public/js/ws.ts');
const chatPath = join(root, 'public/js/features/chat.ts');
const planPath = join(root, 'devlog/_plan/260425_browser_unread_badge/plan.md');
const packagePath = join(root, 'package.json');
const frontendTsconfigPath = join(root, 'tsconfig.frontend.json');

test('AB-001: attention badge module exists and exports the public API', () => {
    assert.ok(existsSync(badgePath), 'attention-badge.ts should exist');
    const src = readFileSync(badgePath, 'utf8');
    for (const name of ['initAttentionBadge', 'notifyUnreadResponse', 'clearUnreadResponses', 'getUnreadResponseCount']) {
        assert.ok(src.includes(`export function ${name}`), `missing export: ${name}`);
    }
});

test('AB-002: attention badge module remains a browser-state leaf module', () => {
    const src = readFileSync(badgePath, 'utf8');
    for (const forbidden of ['./chat', './ws', '../ws', '../main', '../ui', './ui']) {
        assert.ok(!src.includes(`from '${forbidden}`), `attention-badge.ts must not import ${forbidden}`);
        assert.ok(!src.includes(`from "${forbidden}`), `attention-badge.ts must not import ${forbidden}`);
    }
});

test('AB-003: app initializes attention badge before opening the websocket', () => {
    const src = readFileSync(mainPath, 'utf8');
    assert.ok(src.includes("import { initAttentionBadge } from './features/attention-badge.js'"), 'main.ts should import initAttentionBadge');
    const initIdx = src.indexOf('initAttentionBadge();');
    const connectIdx = src.indexOf('connect();');
    assert.ok(initIdx >= 0, 'main.ts should call initAttentionBadge()');
    assert.ok(connectIdx >= 0, 'main.ts should call connect()');
    assert.ok(initIdx < connectIdx, 'initAttentionBadge() should run before connect()');
});

test('AB-004: websocket completion events notify unread badge but new_message does not', () => {
    const src = readFileSync(wsPath, 'utf8');
    assert.ok(src.includes("import { notifyUnreadResponse } from './features/attention-badge.js'"), 'ws.ts should import notifyUnreadResponse');

    const agentBlock = src.slice(src.indexOf("msg.type === 'agent_done'"), src.indexOf("msg.type === 'orchestrate_done'"));
    assert.ok(agentBlock.includes('notifyUnreadResponse();'), 'agent_done should notify unread badge');

    const orcBlock = src.slice(src.indexOf("msg.type === 'orchestrate_done'"), src.indexOf("msg.type === 'clear'"));
    assert.ok(orcBlock.includes('notifyUnreadResponse();'), 'orchestrate_done should notify unread badge');

    const newMessageBlock = src.slice(src.indexOf("msg.type === 'new_message'"));
    assert.ok(!newMessageBlock.includes('notifyUnreadResponse();'), 'new_message should not notify in the first pass');
});

test('AB-005: chat clears unread only after a real send is validated and after clearChat cleanup', () => {
    const src = readFileSync(chatPath, 'utf8');
    assert.ok(src.includes("import { clearUnreadResponses } from './attention-badge.js'"), 'chat.ts should import clearUnreadResponses');

    const emptyGuardIdx = src.indexOf('if (!text && !state.attachedFiles.length) return;');
    const firstClearIdx = src.indexOf('clearUnreadResponses();');
    assert.ok(emptyGuardIdx >= 0, 'sendMessage empty-input guard should exist');
    assert.ok(firstClearIdx > emptyGuardIdx, 'sendMessage should clear unread only after validating a real send');

    const clearChatIdx = src.indexOf('export async function clearChat');
    const clearChatBlock = src.slice(clearChatIdx);
    assert.ok(clearChatBlock.includes('clearUnreadResponses();'), 'clearChat should clear unread responses');
});

test('AB-006: attention badge handles title, favicon, badging API, and completion dedupe', () => {
    const src = readFileSync(badgePath, 'utf8');
    assert.ok(src.includes('document.title'), 'implementation should update and restore document.title');
    assert.ok(src.includes('link[rel~="icon"]'), 'implementation should target the favicon link');
    assert.ok(src.includes("document.createElement('canvas')"), 'implementation should render a canvas favicon badge');
    assert.ok(src.includes('setAppBadge'), 'implementation should use setAppBadge as best-effort enhancement');
    assert.ok(src.includes('clearAppBadge'), 'implementation should use clearAppBadge as best-effort enhancement');
    assert.ok(src.includes('try {') && src.includes('catch {'), 'badging API promise failures should be swallowed');
    assert.ok(src.includes('COMPLETION_DEDUPE_MS'), 'implementation should dedupe completion events');
    assert.ok(src.includes('lastNotifyAt'), 'implementation should track the last notify time for dedupe');
});

test('AB-007: frontend typecheck is available for public/js changes', () => {
    const pkg = readFileSync(packagePath, 'utf8');
    const tsconfig = readFileSync(frontendTsconfigPath, 'utf8');

    assert.ok(pkg.includes('"typecheck:frontend"'), 'package.json should expose frontend typecheck');
    assert.ok(pkg.includes('tsconfig.frontend.json'), 'frontend typecheck should use tsconfig.frontend.json');
    assert.ok(tsconfig.includes('public/js/**/*.ts'), 'frontend tsconfig should include public/js TypeScript files');

    if (existsSync(planPath)) {
        const plan = readFileSync(planPath, 'utf8');
        assert.ok(
            plan.includes('npm run typecheck:frontend') || plan.includes('tsconfig.frontend.json'),
            'plan should require frontend typecheck because root tsc does not cover public/js'
        );
    }
});
