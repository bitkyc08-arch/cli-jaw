import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const skillSrc = readFileSync(join(root, 'skills_ref/web-ai/SKILL.md'), 'utf8');
test('WEB-AI-HEADED-001: live web-ai verification requires headed Chrome', () => {
    const sources = [skillSrc];
    for (const src of sources) {
        assert.match(src, /headed Chrome/i);
        assert.match(src, /headless (?:mode is |is )?(?:forbidden|invalid)/i);
    }
});
