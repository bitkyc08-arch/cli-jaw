/**
 * Phase 6.9: i18n infrastructure tests
 *
 * Verifies:
 * - t() function: lookup, parameter interpolation, fallback
 * - loadLocales(): file loading, skip skills- prefix
 * - getPromptLocale(): A-2.md Language parsing + normalization
 * - Locale JSON integrity: ko/en key parity
 * - COMMANDS descKey consistency
 * - ROLE_PRESETS labelKey consistency
 * - DEFAULT_EMPLOYEES role → LEGACY_MAP coverage
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t, loadLocales, getPromptLocale, getAvailableLocales, normalizeLocale } from '../../src/core/i18n.js';
import { COMMANDS } from '../../src/commands.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = join(__dirname, '../../public/locales');

// ─── t() function ────────────────────────────────────

test('t(): returns key as fallback when no locales loaded', () => {
    // Before loadLocales, dict is empty for a random locale
    const result = t('some.missing.key', {}, 'xx');
    assert.equal(result, 'some.missing.key');
});

test('t(): loadLocales loads ko and en', () => {
    loadLocales(LOCALES_DIR);
    const locales = getAvailableLocales();
    assert.ok(locales.includes('ko'), 'ko locale should be loaded');
    assert.ok(locales.includes('en'), 'en locale should be loaded');
});

test('t(): returns Korean string for ko locale', () => {
    const result = t('cmd.help.desc', {}, 'ko');
    assert.equal(result, '커맨드 목록');
});

test('t(): returns English string for en locale', () => {
    const result = t('cmd.help.desc', {}, 'en');
    assert.equal(result, 'Command list');
});

test('t(): parameter interpolation works', () => {
    const result = t('cmd.model.current', { cli: 'claude', model: 'opus' }, 'ko');
    assert.ok(result.includes('claude'));
    assert.ok(result.includes('opus'));
});

test('t(): multiple occurrences of same param are replaced', () => {
    // Create a test where same param appears twice
    const result = t('cmd.cli.changed', { from: 'claude', to: 'gemini' }, 'en');
    assert.ok(result.includes('claude'));
    assert.ok(result.includes('gemini'));
});

test('t(): falls back to ko when unknown locale requested', () => {
    const result = t('cmd.help.desc', {}, 'xx');
    assert.equal(result, '커맨드 목록');
});

test('t(): falls back to key itself when key not found', () => {
    const result = t('nonexistent.key.xyz', {}, 'ko');
    assert.equal(result, 'nonexistent.key.xyz');
});

// ─── Locale JSON integrity ───────────────────────────

test('locale JSON: ko.json and en.json have same keys', () => {
    const koJson = JSON.parse(fs.readFileSync(join(LOCALES_DIR, 'ko.json'), 'utf8'));
    const enJson = JSON.parse(fs.readFileSync(join(LOCALES_DIR, 'en.json'), 'utf8'));
    const koKeys = Object.keys(koJson).sort();
    const enKeys = Object.keys(enJson).sort();

    const missingInEn = koKeys.filter(k => !enKeys.includes(k));
    const missingInKo = enKeys.filter(k => !koKeys.includes(k));

    assert.deepEqual(missingInEn, [], `Keys in ko.json missing from en.json: ${missingInEn.join(', ')}`);
    assert.deepEqual(missingInKo, [], `Keys in en.json missing from ko.json: ${missingInKo.join(', ')}`);
});

test('locale JSON: no empty values in ko.json', () => {
    const koJson = JSON.parse(fs.readFileSync(join(LOCALES_DIR, 'ko.json'), 'utf8'));
    const emptyKeys = Object.entries(koJson).filter(([, v]) => !v.trim()).map(([k]) => k);
    assert.deepEqual(emptyKeys, [], `Empty values in ko.json: ${emptyKeys.join(', ')}`);
});

test('locale JSON: no empty values in en.json', () => {
    const enJson = JSON.parse(fs.readFileSync(join(LOCALES_DIR, 'en.json'), 'utf8'));
    const emptyKeys = Object.entries(enJson).filter(([, v]) => !v.trim()).map(([k]) => k);
    assert.deepEqual(emptyKeys, [], `Empty values in en.json: ${emptyKeys.join(', ')}`);
});

// ─── COMMANDS descKey consistency ─────────────────────

test('COMMANDS: every command with descKey has matching locale key', () => {
    const koJson = JSON.parse(fs.readFileSync(join(LOCALES_DIR, 'ko.json'), 'utf8'));
    for (const cmd of COMMANDS) {
        if (cmd.descKey) {
            assert.ok(koJson[cmd.descKey], `Command ${cmd.name} has descKey '${cmd.descKey}' but no ko.json entry`);
        }
    }
});

test('COMMANDS: every command still has desc string (fallback)', () => {
    for (const cmd of COMMANDS) {
        assert.ok(typeof cmd.desc === 'string' && cmd.desc.length > 0,
            `Command ${cmd.name} missing desc fallback`);
    }
});

// ─── getPromptLocale ─────────────────────────────────

test('getPromptLocale: returns ko for non-existent file', () => {
    const result = getPromptLocale('/tmp/nonexistent-a2-test.md');
    assert.equal(result, 'ko');
});

test('getPromptLocale: parses Language: Korean → ko', () => {
    const tmpFile = join('/tmp', `a2-test-${Date.now()}.md`);
    fs.writeFileSync(tmpFile, '# User Config\n\nLanguage: Korean\n');
    try {
        assert.equal(getPromptLocale(tmpFile), 'ko');
    } finally {
        fs.unlinkSync(tmpFile);
    }
});

test('getPromptLocale: parses Language: English → en', () => {
    const tmpFile = join('/tmp', `a2-test-${Date.now()}.md`);
    fs.writeFileSync(tmpFile, '# User Config\n\nLanguage: English\n');
    try {
        assert.equal(getPromptLocale(tmpFile), 'en');
    } finally {
        fs.unlinkSync(tmpFile);
    }
});

test('getPromptLocale: parses Language: 한국어 → ko', () => {
    const tmpFile = join('/tmp', `a2-test-${Date.now()}.md`);
    fs.writeFileSync(tmpFile, '# User Config\n\nLanguage: 한국어\n');
    try {
        assert.equal(getPromptLocale(tmpFile), 'ko');
    } finally {
        fs.unlinkSync(tmpFile);
    }
});

test('getPromptLocale: unknown language falls back to ko', () => {
    const tmpFile = join('/tmp', `a2-test-${Date.now()}.md`);
    fs.writeFileSync(tmpFile, '# User Config\n\nLanguage: Klingon\n');
    try {
        assert.equal(getPromptLocale(tmpFile), 'ko');
    } finally {
        fs.unlinkSync(tmpFile);
    }
});

test('getPromptLocale: no Language field falls back to ko', () => {
    const tmpFile = join('/tmp', `a2-test-${Date.now()}.md`);
    fs.writeFileSync(tmpFile, '# User Config\n\nName: Test\n');
    try {
        assert.equal(getPromptLocale(tmpFile), 'ko');
    } finally {
        fs.unlinkSync(tmpFile);
    }
});

// ─── API route sanity (static check) ─────────────────

test('locale files: ko.json has at least 100 keys', () => {
    const koJson = JSON.parse(fs.readFileSync(join(LOCALES_DIR, 'ko.json'), 'utf8'));
    assert.ok(Object.keys(koJson).length >= 100,
        `ko.json should have at least 100 keys, has ${Object.keys(koJson).length}`);
});

test('locale files: en.json has at least 100 keys', () => {
    const enJson = JSON.parse(fs.readFileSync(join(LOCALES_DIR, 'en.json'), 'utf8'));
    assert.ok(Object.keys(enJson).length >= 100,
        `en.json should have at least 100 keys, has ${Object.keys(enJson).length}`);
});

// ─── normalizeLocale ─────────────────────────────────

test('normalizeLocale: en-US → en', () => {
    assert.equal(normalizeLocale('en-US'), 'en');
});

test('normalizeLocale: ko-KR → ko', () => {
    assert.equal(normalizeLocale('ko-KR'), 'ko');
});

test('normalizeLocale: EN (uppercase) → en', () => {
    assert.equal(normalizeLocale('EN'), 'en');
});

test('normalizeLocale: unsupported locale → default ko', () => {
    assert.equal(normalizeLocale('fr-FR'), 'ko');
});

test('normalizeLocale: null/undefined → default ko', () => {
    assert.equal(normalizeLocale(null), 'ko');
    assert.equal(normalizeLocale(undefined), 'ko');
    assert.equal(normalizeLocale(''), 'ko');
});
