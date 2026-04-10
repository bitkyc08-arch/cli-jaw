// Orchestrator snapshot reconnect — Phase 9 (source-shape, no browser import)
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wsPathTs = join(__dirname, '../../public/js/ws.ts');
const wsPathJs = join(__dirname, '../../public/js/ws.js');
const wsPath = existsSync(wsPathTs) ? wsPathTs : wsPathJs;
const hasWs = existsSync(wsPath);

test('OSR-001: ws source exports hydrateAgentPhases function', { skip: !hasWs && 'public/js/ws source not found' }, () => {
    const wsSrc = readFileSync(wsPath, 'utf8');
    assert.ok(wsSrc.includes('hydrateAgentPhases'),
        'ws source should define hydrateAgentPhases');
});

test('OSR-002: hydrateAgentPhases handles phase and phaseLabel fields', { skip: !hasWs && 'public/js/ws source not found' }, () => {
    const wsSrc = readFileSync(wsPath, 'utf8');
    assert.ok(wsSrc.includes('phase') && wsSrc.includes('phaseLabel'),
        'hydrateAgentPhases should reference phase and phaseLabel');
});

test('OSR-003: ws source tracks current orc scope and ignores foreign orc_state events', { skip: !hasWs && 'public/js/ws source not found' }, () => {
    const wsSrc = readFileSync(wsPath, 'utf8');
    assert.ok(wsSrc.includes('currentOrcScope'), 'ws should track current orc scope');
    assert.ok(wsSrc.includes('msg.scope !== currentOrcScope'), 'ws should filter foreign scope events');
});
