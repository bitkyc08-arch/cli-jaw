import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Pi settings routes use registration validation, applySettings, and redaction', () => {
    const source = readFileSync('src/routes/settings.ts', 'utf8');
    assert.match(source, /app\.post\('\/api\/pi\/profiles\/register'/);
    assert.match(source, /normalizePiProfile\(req\.body\)/);
    assert.match(source, /await discoverPiProfileModels\(nextPi, profile\)/);
    assert.match(source, /models\.includes\(profile\.model\)/);
    assert.match(source, /modelSource: discovery\.source/);
    assert.match(source, /await applySettings\(\{/);
    assert.match(source, /redactPiSettings/);
});

test('Pi model route discovers models from the selected profile', () => {
    const source = readFileSync('src/routes/settings.ts', 'utf8');
    assert.match(source, /app\.get\('\/api\/pi\/models'/);
    assert.match(source, /const piSettings = normalizePiSettings\(settings\["pi"\]\)/);
    assert.match(source, /await discoverPiProfileModels\(piSettings, selected\)/);
    assert.match(source, /Unknown pi profile:/);
    assert.match(source, /res\.status\(400\)\.json/);
    assert.match(source, /modelSource: discovery\.source/);
});
