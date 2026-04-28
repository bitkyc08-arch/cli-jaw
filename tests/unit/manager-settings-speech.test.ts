// Phase 4 — Speech & Keys page primitives.
//
// Pure helpers + dirty-store wiring for the SpeechKeys page. Verifies:
//   • engine reveal table (auto reveals all four)
//   • vertexConfig JSON validation (empty ok, malformed rejected)
//   • secret fields never emit a dirty entry on empty input
//   • engine switch produces a single dotted dirty key
//   • saveBundle + expandPatch produce the nested PUT body shape
//   • invalid vertexConfig is dropped from the save bundle

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDirtyStore } from '../../public/manager/src/settings/dirty-store';
import { expandPatch } from '../../public/manager/src/settings/pages/path-utils';
import {
    STT_ENGINES,
    revealsForEngine,
    validateVertexConfig,
} from '../../public/manager/src/settings/pages/SpeechKeys';

// ─── engine reveal table ─────────────────────────────────────────────

test('STT_ENGINES exposes the five expected engines', () => {
    assert.deepEqual(
        [...STT_ENGINES].sort(),
        ['auto', 'gemini', 'openai', 'vertex', 'whisper'],
    );
});

test('engine=auto reveals every concrete engine subsection', () => {
    const reveals = revealsForEngine('auto');
    assert.deepEqual(
        [...reveals].sort(),
        ['gemini', 'openai', 'vertex', 'whisper'],
    );
});

test('engine=gemini reveals only the gemini subsection', () => {
    assert.deepEqual([...revealsForEngine('gemini')], ['gemini']);
    assert.equal(revealsForEngine('gemini').includes('openai'), false);
    assert.equal(revealsForEngine('gemini').includes('whisper'), false);
    assert.equal(revealsForEngine('gemini').includes('vertex'), false);
});

test('engine=openai|whisper|vertex reveal only their own subsection', () => {
    assert.deepEqual([...revealsForEngine('openai')], ['openai']);
    assert.deepEqual([...revealsForEngine('whisper')], ['whisper']);
    assert.deepEqual([...revealsForEngine('vertex')], ['vertex']);
});

// ─── vertexConfig JSON validation ────────────────────────────────────

test('validateVertexConfig accepts empty string (clears credentials)', () => {
    const result = validateVertexConfig('');
    assert.equal(result.valid, true);
    assert.equal(result.error, null);
});

test('validateVertexConfig accepts whitespace-only as empty', () => {
    const result = validateVertexConfig('   \n  ');
    assert.equal(result.valid, true);
});

test('validateVertexConfig accepts well-formed JSON', () => {
    const result = validateVertexConfig(
        '{"type":"service_account","project_id":"x"}',
    );
    assert.equal(result.valid, true);
    assert.equal(result.error, null);
});

test('validateVertexConfig rejects malformed JSON with a message', () => {
    const result = validateVertexConfig('{not-valid');
    assert.equal(result.valid, false);
    assert.ok(result.error && result.error.length > 0);
});

// ─── secret field semantics ──────────────────────────────────────────

test('Empty Gemini API key input does not create a dirty entry', () => {
    // Page contract mirror: typing then erasing the field should remove
    // the dirty key so the saved secret is preserved.
    const store = createDirtyStore();
    store.set('stt.geminiApiKey', { value: 'partial', original: '', valid: true });
    assert.equal(store.pending.has('stt.geminiApiKey'), true);
    store.remove('stt.geminiApiKey');
    assert.equal(store.pending.has('stt.geminiApiKey'), false);
});

test('Empty OpenAI API key input does not create a dirty entry', () => {
    const store = createDirtyStore();
    store.set('stt.openaiApiKey', { value: '', original: '', valid: true });
    // empty/original equality clears the entry automatically
    assert.equal(store.isDirty(), false);
    assert.equal(store.pending.has('stt.openaiApiKey'), false);
});

// ─── engine switch wiring ────────────────────────────────────────────

test('Switching engine writes a single dotted dirty key', () => {
    const store = createDirtyStore();
    store.set('stt.engine', { value: 'gemini', original: 'auto', valid: true });
    assert.equal(store.pending.size, 1);
    assert.equal(store.pending.get('stt.engine')?.value, 'gemini');
});

test('Reverting engine to original clears the dirty entry', () => {
    const store = createDirtyStore();
    store.set('stt.engine', { value: 'gemini', original: 'auto', valid: true });
    store.set('stt.engine', { value: 'auto', original: 'auto', valid: true });
    assert.equal(store.isDirty(), false);
    assert.equal(store.pending.size, 0);
});

// ─── saveBundle + expandPatch shape ──────────────────────────────────

test('Speech edits expand to nested PUT body under stt.*', () => {
    const store = createDirtyStore();
    store.set('stt.engine', { value: 'gemini', original: 'auto', valid: true });
    store.set('stt.geminiApiKey', {
        value: 'AIzaSyTest',
        original: '',
        valid: true,
    });
    store.set('stt.geminiModel', {
        value: 'gemini-2.5-flash',
        original: 'gemini-2.5-flash-lite',
        valid: true,
    });
    const patch = expandPatch(store.saveBundle());
    assert.deepEqual(patch, {
        stt: {
            engine: 'gemini',
            geminiApiKey: 'AIzaSyTest',
            geminiModel: 'gemini-2.5-flash',
        },
    });
});

test('Vertex JSON config is sent as a string under stt.vertexConfig', () => {
    const store = createDirtyStore();
    const json = '{"type":"service_account","project_id":"jaw"}';
    store.set('stt.vertexConfig', { value: json, original: '', valid: true });
    const patch = expandPatch(store.saveBundle());
    assert.deepEqual(patch, { stt: { vertexConfig: json } });
});

test('Invalid vertexConfig is dropped from the save bundle', () => {
    const store = createDirtyStore();
    store.set('stt.vertexConfig', { value: '{bad', original: '', valid: false });
    store.set('stt.engine', { value: 'vertex', original: 'auto', valid: true });
    const bundle = store.saveBundle();
    assert.deepEqual(Object.keys(bundle), ['stt.engine']);
});

test('OpenAI base URL + model edits expand correctly', () => {
    const store = createDirtyStore();
    store.set('stt.openaiBaseUrl', {
        value: 'https://proxy.example/v1',
        original: '',
        valid: true,
    });
    store.set('stt.openaiModel', {
        value: 'whisper-1',
        original: '',
        valid: true,
    });
    const patch = expandPatch(store.saveBundle());
    assert.deepEqual(patch, {
        stt: {
            openaiBaseUrl: 'https://proxy.example/v1',
            openaiModel: 'whisper-1',
        },
    });
});

test('Whisper-only edit produces stt.whisperModel patch', () => {
    const store = createDirtyStore();
    store.set('stt.whisperModel', {
        value: 'mlx-community/whisper-large-v3-mlx',
        original: 'mlx-community/whisper-large-v3-turbo',
        valid: true,
    });
    const patch = expandPatch(store.saveBundle());
    assert.deepEqual(patch, {
        stt: { whisperModel: 'mlx-community/whisper-large-v3-mlx' },
    });
});

// ─── save gating ─────────────────────────────────────────────────────

test('No edits → empty bundle → save is a no-op shape', () => {
    const store = createDirtyStore();
    assert.equal(store.isDirty(), false);
    assert.deepEqual(store.saveBundle(), {});
});
