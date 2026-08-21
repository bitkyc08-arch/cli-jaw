// Cycle 3 (parity2 030): GPT-5.6 family vocabulary, Power tier label mapping,
// zh label projections, and the effort-verification axis surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeChatGptFamilyChoice,
    CHATGPT_FAMILY_OPTIONS,
    effortChoiceFromPowerTierLabel,
    normalizeChatGptModelChoice,
    normalizeChatGptEffortChoice,
    CHATGPT_MODEL_OPTIONS,
    normalizeModelPickerText,
    modelChoiceFromText,
} from '../../src/browser/web-ai/chatgpt-model.ts';

test('MP-FAM-1: family normalization table', () => {
    assert.equal(normalizeChatGptFamilyChoice('gpt-5.6-sol'), 'gpt-5.6-sol');
    assert.equal(normalizeChatGptFamilyChoice('GPT-5.6'), 'gpt-5.6-sol');
    assert.equal(normalizeChatGptFamilyChoice('sol'), 'gpt-5.6-sol');
    assert.equal(normalizeChatGptFamilyChoice('gpt-5.5'), 'gpt-5.5');
    assert.equal(normalizeChatGptFamilyChoice('o3'), 'o3');
    assert.equal(normalizeChatGptFamilyChoice('gpt-4'), null);
    assert.equal(normalizeChatGptFamilyChoice(undefined), null);
    assert.equal(CHATGPT_FAMILY_OPTIONS['gpt-5.6-sol'].label, 'GPT-5.6 Sol');
});

test('MP-PWR-1: power tier label resolves effort, label-first with index cross-check', () => {
    // label alone
    assert.equal(effortChoiceFromPowerTierLabel('Extra High, 4 of 5.', null), 'heavy');
    assert.equal(effortChoiceFromPowerTierLabel('Medium, 2 of 5.', null), 'standard');
    assert.equal(effortChoiceFromPowerTierLabel('High', null), 'extended');
    // index alone (1 Medium, 2 High, 3 Extra High)
    assert.equal(effortChoiceFromPowerTierLabel(null, 1), 'standard');
    assert.equal(effortChoiceFromPowerTierLabel(null, 2), 'extended');
    assert.equal(effortChoiceFromPowerTierLabel(null, 3), 'heavy');
    // agreement
    assert.equal(effortChoiceFromPowerTierLabel('High, 3 of 5.', 2), 'extended');
    // DISAGREEMENT fails closed
    assert.equal(effortChoiceFromPowerTierLabel('Extra High, 4 of 5.', 1), null);
    // zh labels
    assert.equal(effortChoiceFromPowerTierLabel('极高, 4 of 5.', null), 'heavy');
    assert.equal(effortChoiceFromPowerTierLabel('中等', null), 'standard');
});

test('MP-ZH-1: zh model labels resolve to the same canonical choices', () => {
    assert.equal(modelChoiceFromText('即时'), 'instant');
    assert.equal(modelChoiceFromText('思考'), normalizeChatGptModelChoice('thinking') ? modelChoiceFromText('思考') : null);
    assert.ok(CHATGPT_MODEL_OPTIONS.instant.labels.includes('即时'));
    assert.ok(CHATGPT_MODEL_OPTIONS.thinking.labels.includes('中等'));
    assert.ok(CHATGPT_MODEL_OPTIONS.pro.labels.includes('Pro 扩展'));
    // normalization keeps CJK
    assert.equal(normalizeModelPickerText('  即时 '), '即时');
});

test('MP-ALIAS-1: 5.6 model aliases map into the canonical trio', () => {
    assert.equal(normalizeChatGptModelChoice('gpt-5.6-thinking'), 'thinking');
    assert.equal(normalizeChatGptModelChoice('gpt-5.6-pro'), 'pro');
    assert.equal(normalizeChatGptEffortChoice('high'), 'extended');
    assert.equal(normalizeChatGptEffortChoice('heavy'), 'heavy');
});

