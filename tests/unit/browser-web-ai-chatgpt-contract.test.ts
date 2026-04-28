import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isChatGptUrl } from '../../src/browser/web-ai/chatgpt.ts';
import { saveBaseline, getBaseline } from '../../src/browser/web-ai/session.ts';
import { normalizeEnvelope } from '../../src/browser/web-ai/question.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const chatgptSrc = fs.readFileSync(join(root, 'src/browser/web-ai/chatgpt.ts'), 'utf8');

test('BWAC-001: ChatGPT URL allowlist is narrow', () => {
    assert.equal(isChatGptUrl('https://chatgpt.com/'), true);
    assert.equal(isChatGptUrl('https://chat.openai.com/c/abc'), true);
    assert.equal(isChatGptUrl('https://gemini.google.com/app'), false);
});

test('BWAC-002: active tab must be verified before web-ai actions', () => {
    assert.match(chatgptSrc, /requireVerifiedChatGptTab/);
    assert.match(chatgptSrc, /Run tabs --json then tab-switch before web-ai/);
    assert.match(chatgptSrc, /getActiveTab\(port\)/);
});

test('BWAC-003: send captures baseline before prompt insertion', () => {
    const assistantIndex = chatgptSrc.indexOf('const assistantCount = await countAssistantMessages');
    const fillIndex = chatgptSrc.indexOf('await fillComposer');
    assert.ok(assistantIndex > -1);
    assert.ok(fillIndex > assistantIndex);
});

test('BWAC-004: baseline uses promptHash and targetId only', () => {
    const envelope = normalizeEnvelope({ vendor: 'chatgpt', prompt: 'hello' });
    const baseline = saveBaseline({
        vendor: 'chatgpt',
        targetId: 'target-1',
        url: 'https://chatgpt.com/',
        envelope,
        assistantCount: 2,
    });
    assert.equal(baseline.targetId, 'target-1');
    assert.equal(baseline.assistantCount, 2);
    assert.equal(getBaseline('chatgpt', 'target-1')?.promptHash, baseline.promptHash);
    assert.equal('prompt' in baseline, false);
});

test('BWAC-005: placeholder answers are filtered', () => {
    assert.match(chatgptSrc, /PLACEHOLDER_PATTERNS/);
    assert.match(chatgptSrc, /Answer now/i);
    assert.match(chatgptSrc, /Pro thinking/i);
});
