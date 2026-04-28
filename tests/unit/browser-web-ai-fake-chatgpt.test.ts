import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fakeFixturePath = join(root, 'devlog/_plan/web_connect/_ref/30_browser/test/integration/web-ai-fake-chatgpt.test.mjs');
const standaloneTypesPath = join(root, 'devlog/_plan/web_connect/_ref/30_browser/web-ai/types.mjs');

test('BWAF-001: 30_browser fake ChatGPT fixture covers DOM runtime flow', () => {
    const fixture = fs.readFileSync(fakeFixturePath, 'utf8');
    assert.match(fixture, /queryWebAi/);
    assert.match(fixture, /createFakeChatGptPage/);
    assert.match(fixture, /Pro thinking/);
    assert.match(fixture, /## Question\\nReply exactly: OK/);
    assert.match(fixture, /assistantCount/);
});

test('BWAF-002: 30_browser standalone web-ai has explicit types surface', () => {
    const types = fs.readFileSync(standaloneTypesPath, 'utf8');
    assert.match(types, /QuestionEnvelope/);
    assert.match(types, /RenderedQuestionBundle/);
    assert.match(types, /CommittedTurnBaseline/);
    assert.match(types, /WebAiOutput/);
});
