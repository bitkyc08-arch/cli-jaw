import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildArgs, buildResumeArgs } from '../../src/agent/args.ts';
import { detectAgyCapabilities, parseAgyHelp, type AgyCapabilities } from '../../src/agent/agy-capabilities.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function fixture(name: string): string {
    return readFileSync(join(__dirname, '../fixtures/agy-help', name), 'utf8');
}

const CURRENT_CAPS = parseAgyHelp(fixture('agy-1.0.12-help.txt'), '1.0.12');

test('AGY-CAP-001: parses AGY 1.0.12 help flags', () => {
    assert.equal(CURRENT_CAPS.version, '1.0.12');
    assert.equal(CURRENT_CAPS.print, true);
    assert.equal(CURRENT_CAPS.printFlag, '-p');
    assert.equal(CURRENT_CAPS.model, true);
    assert.equal(CURRENT_CAPS.logFile, true);
    assert.equal(CURRENT_CAPS.printTimeout, true);
    assert.equal(CURRENT_CAPS.conversation, true);
    assert.equal(CURRENT_CAPS.addDir, true);
    assert.equal(CURRENT_CAPS.dangerousSkipPermissions, true);
    assert.equal(CURRENT_CAPS.sandbox, true);
});

test('AGY-CAP-002: older fixture omits unsupported optional model flag', () => {
    const caps = parseAgyHelp(fixture('agy-older-no-model-help.txt'), '1.0.0');
    assert.equal(caps.version, '1.0.0');
    assert.equal(caps.print, true);
    assert.equal(caps.model, false);
    assert.equal(caps.conversation, true);
});

test('AGY-CAP-003: gated fresh args omit unsupported optional AGY flags', () => {
    const caps: AgyCapabilities = {
        print: true,
        printFlag: '-p',
        conversation: true,
        model: false,
        printTimeout: false,
        logFile: false,
        addDir: false,
        dangerousSkipPermissions: false,
        sandbox: true,
    };
    const args = buildArgs('agy', 'gemini-3.5-flash', '', 'hi', '', 'auto', {
        agyCapabilities: caps,
        agyLogFile: '/tmp/jaw-agy.log',
        agyPrintTimeout: '10m',
        workingDir: '/repo',
    });
    assert.deepEqual(args, ['-p', 'hi']);
    assert.equal(args.includes('--sandbox'), false);
});

test('AGY-CAP-004: gated resume rejects missing conversation support', () => {
    assert.throws(() => buildResumeArgs('agy', 'default', '', 'sess-1', 'hi', 'auto', {
        agyCapabilities: { ...CURRENT_CAPS, conversation: false },
    }), /requires --conversation support/);
});

test('AGY-CAP-005: gated fresh args reject missing print mode', () => {
    const caps: AgyCapabilities = { ...CURRENT_CAPS, print: false };
    delete caps.printFlag;
    assert.throws(() => buildArgs('agy', 'default', '', 'hi', '', 'auto', {
        agyCapabilities: caps,
    }), /requires print mode support/);
});

test('AGY-CAP-006: spawn wires AGY capability probe into arg options', () => {
    const spawnSrc = readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    assert.match(spawnSrc, /detectAgyCapabilities\(agyBinaryForCapabilities\)/);
    assert.match(spawnSrc, /agyCapabilities\?\.usedFallback/);
    assert.match(spawnSrc, /\[agy-capabilities\] probe failed; using legacy emit-all argv compatibility/);
    assert.match(spawnSrc, /\.\.\.\(agyCapabilities \? \{ agyCapabilities \} : \{\}\)/);
});

test('AGY-CAP-007: detection parses help emitted on stderr', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaw-agy-cap-'));
    const bin = join(dir, 'agy');
    writeFileSync(bin, [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo "1.0.12"; exit 0; fi',
        'if [ "$1" = "--help" ]; then',
        '  printf "%s\\n" "Usage of agy:" "  --conversation" "  --model" "  --log-file" "  -p" "  --print-timeout" "  --add-dir" "  --dangerously-skip-permissions" "  --sandbox" 1>&2',
        '  exit 0',
        'fi',
        'exit 1',
        '',
    ].join('\n'));
    chmodSync(bin, 0o755);
    try {
        const caps = detectAgyCapabilities(bin);
        assert.equal(caps.version, '1.0.12');
        assert.equal(caps.print, true);
        assert.equal(caps.model, true);
        assert.equal(caps.conversation, true);
        assert.equal(caps.usedFallback, undefined);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
