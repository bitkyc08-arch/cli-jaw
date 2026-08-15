// Dev skill governance patch — 94 prompt-snapshot scenarios (S1-S5).
// Verifies C0-C5 Boss contract + task_tags employee routing (92/98/99).
import test from 'node:test';
import assert from 'node:assert/strict';
import { getSystemPrompt, getEmployeePromptV2, normalizeTaskTags, clearPromptCache } from '../../src/prompt/builder.ts';

const emp = { name: 'TagTest', cli: 'codex' };

test('S1: Boss prompt carries classification contract + compact PABCD, no full skill body', () => {
    const prompt = getSystemPrompt({ forDisk: false });
    assert.ok(prompt.includes('## Dev Work Classification (contract)'), 'classification contract present');
    assert.ok(prompt.includes('classify work C0-C5'), 'C0-C5 classifier line present');
    // Pin distinguishing contract content per class so a wrong/swapped contract fails:
    assert.ok(prompt.includes('C2 ordinary product slice — endpoint/form/screen'), 'C2 signals present');
    assert.ok(prompt.includes('C4 high-risk — auth/payments/security/data deletion/migration/release/permissions'), 'C4 signals present');
    assert.ok(prompt.includes('the higher class wins'), 'tie-break rule present');
    assert.ok(prompt.includes('full PABCD for C4'), 'C4 default process present');
    assert.ok(prompt.includes('C4-promotion triggers (DEV-ESCALATE-01:'), 'promotion trigger list present');
    assert.ok(prompt.includes('Ask the user before destructive actions'), 'ask-user clause present');
    assert.ok(!prompt.includes('Delegation Trap'), 'full dev-pabcd body must not be inlined');
});

// S2/S3 use phase 3 deliberately: at phase 4 the Phase Guide injects dev-testing
// unconditionally, which would make the tag-routing assertions vacuous.
test('S2: frontend + task_tags ["tdd"] adds dev-testing, not dev-security', () => {
    clearPromptCache();
    const prompt = getEmployeePromptV2(emp, 'frontend', 3, { taskTags: ['tdd'] });
    assert.ok(prompt.includes('## Task Tag Guides'), 'tag section present');
    assert.ok(prompt.includes('jaw-dev-testing'), 'tdd loads jaw-dev-testing');
    assert.ok(!prompt.includes('jaw-dev-security'), 'unrelated security guide absent');
});

test('S3: backend + threat_model/migration_backfill adds security+data+testing', () => {
    clearPromptCache();
    const prompt = getEmployeePromptV2(emp, 'backend', 3, { taskTags: ['threat_model', 'migration_backfill'] });
    assert.ok(prompt.includes('jaw-dev-security'), 'threat_model loads jaw-dev-security');
    assert.ok(prompt.includes('jaw-dev-data'), 'migration_backfill loads jaw-dev-data');
    assert.ok(prompt.includes('jaw-dev-testing'), 'migration_backfill loads jaw-dev-testing');
    assert.ok(prompt.includes('your execution role stays "backend"'), 'role unchanged by tags');
});

test('S4: legacy no-tag dispatch keeps existing shape (no tag section)', () => {
    clearPromptCache();
    const tagged = getEmployeePromptV2(emp, 'frontend', 3, { taskTags: [] });
    assert.ok(!tagged.includes('## Task Tag Guides'), 'no tag section without tags');
    clearPromptCache();
    const legacy = getEmployeePromptV2(emp, 'frontend', 3, {});
    assert.equal(tagged, legacy, 'empty tags === legacy opts output');
});

test('S5: frontend_ui adds dev-uiux-design alongside frontend role guide', () => {
    clearPromptCache();
    const prompt = getEmployeePromptV2(emp, 'frontend', 3, { taskTags: ['frontend_ui'] });
    assert.ok(prompt.includes('jaw-dev-uiux-design'), 'frontend_ui loads jaw-dev-uiux-design');
    assert.ok(prompt.includes('Role guide: jaw-dev-frontend'), 'role guide intact');
});

test('normalizeTaskTags: trims, lowercases, dedups, sorts, drops junk', () => {
    assert.deepEqual(normalizeTaskTags([' TDD ', 'tdd', 'Threat-Model', 7, '', null]), ['tdd', 'threat_model']);
    // Bare string is coerced to a single tag (dev §0.3), not silently dropped:
    assert.deepEqual(normalizeTaskTags('tdd'), ['tdd']);
    assert.deepEqual(normalizeTaskTags(undefined), []);
    // Comma/colon separators normalize to underscores — no cache-key collision
    // with the comma-joined key, and malformed tags surface as Unrecognized:
    assert.deepEqual(normalizeTaskTags(['security,tdd']), ['security_tdd']);
});

test('product_discovery alone still renders the tag section (visible tag, no extra guide)', () => {
    clearPromptCache();
    const prompt = getEmployeePromptV2(emp, 'backend', 3, { taskTags: ['product_discovery'] });
    assert.ok(prompt.includes('## Task Tag Guides'), 'tag section rendered even when mapped skills dedup away');
    assert.ok(prompt.includes('product_discovery'), 'tag named in prompt');
});

test('unknown tags are surfaced, not silently dropped', () => {
    clearPromptCache();
    const prompt = getEmployeePromptV2(emp, 'backend', 3, { taskTags: ['nonexistent_method'] });
    assert.ok(prompt.includes('Unrecognized tags (no extra guide): nonexistent_method'));
});

test('tag cache key separates tagged and untagged prompts', () => {
    clearPromptCache();
    const a = getEmployeePromptV2(emp, 'backend', 3, { taskTags: ['tdd'] });
    const b = getEmployeePromptV2(emp, 'backend', 3, {});
    assert.notEqual(a, b, 'tagged prompt must not be served from untagged cache entry');
});
