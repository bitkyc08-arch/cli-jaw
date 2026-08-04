import test from 'node:test';
import assert from 'node:assert/strict';
import { readCodexRootOpenAiBaseUrl } from '../../src/core/codex-config.ts';
import { normalizeOpenAiBaseUrl } from '../../src/cli/opencodex-runtime.ts';

test('root openai_base_url reader ignores table-scoped duplicates', () => {
    assert.equal(readCodexRootOpenAiBaseUrl('openai_base_url = "http://127.0.0.1:10100/v1"\n[model_providers.ocx]\nopenai_base_url = "bad"'), 'http://127.0.0.1:10100/v1');
    assert.equal(readCodexRootOpenAiBaseUrl('[model_providers.ocx]\nopenai_base_url = "http://127.0.0.1:10100/v1"'), null);
    assert.equal(readCodexRootOpenAiBaseUrl("openai_base_url='http://127.0.0.1:10100/v1/' # ocx"), 'http://127.0.0.1:10100/v1/');
    assert.equal(normalizeOpenAiBaseUrl('http://127.0.0.1:10100/v1/'), 'http://127.0.0.1:10100/v1');
});
