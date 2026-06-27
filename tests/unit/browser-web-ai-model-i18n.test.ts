import test from 'node:test';
import assert from 'node:assert/strict';
import { modelChoiceFromText, normalizeModelPickerText } from '../../src/browser/web-ai/chatgpt-model.js';

// 104.6: cli-jaw's model picker was English-only and ASCII-stripped Korean menu text to ''
// (which made all pure-Korean labels collide). Korean locale must now resolve correctly.
test('BWAI-MODELI18N-001: Korean model menu text maps to the right tier', () => {
    assert.equal(modelChoiceFromText('즉시'), 'instant');
    assert.equal(modelChoiceFromText('중간'), 'thinking');
    assert.equal(modelChoiceFromText('높음'), 'thinking');
    assert.equal(modelChoiceFromText('매우 높음'), 'thinking');
    assert.equal(modelChoiceFromText('Pro 확장'), 'pro');
    assert.equal(modelChoiceFromText('프로 확장'), 'pro');
    // English still resolves
    assert.equal(modelChoiceFromText('Instant'), 'instant');
    assert.equal(modelChoiceFromText('Extra High'), 'thinking');
    assert.equal(modelChoiceFromText('Pro Extended'), 'pro');
});

test('BWAI-MODELI18N-002: normalize preserves Korean (distinct, not collapsed to empty)', () => {
    assert.equal(normalizeModelPickerText('즉시'), '즉시');
    // distinct Korean labels must not collide (the old ASCII strip made both '')
    assert.notEqual(normalizeModelPickerText('즉시'), normalizeModelPickerText('중간'));
    // exact-line match still works for Korean after trimming
    assert.equal(normalizeModelPickerText('  매우 높음  '), normalizeModelPickerText('매우 높음'));
    // English unchanged
    assert.equal(normalizeModelPickerText('Pro Extended'), 'pro extended');
});
