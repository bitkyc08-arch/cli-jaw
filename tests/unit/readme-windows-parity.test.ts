import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const READMES = ['README.md', 'README.ko.md', 'README.zh-CN.md', 'README.ja.md'];
const CONTRACT = JSON.parse(read('scripts/windows-support-contract.json'));

/**
 * Parse the marked Windows block's metadata from one README.
 *
 * Each file is parsed INDEPENDENTLY and on purpose: joining the four and searching the
 * result would let one correct file mask three stale ones, which is exactly how the
 * English/Korean divergence in #373 survived.
 */
function parseWindowsBlock(text: string): Record<string, string> | null {
    const match = text.match(/<!-- windows-support:start\n([\s\S]*?)-->/);
    if (!match) return null;
    const out: Record<string, string> = {};
    for (const line of match[1]!.split('\n')) {
        const kv = line.match(/^\s{5}([a-z-]+):\s*(.+?)\s*$/);
        if (kv) out[kv[1]!] = kv[2]!;
    }
    return out;
}

test('RWP-001: every README carries the marked Windows block', () => {
    for (const file of READMES) {
        assert.ok(parseWindowsBlock(read(file)), `${file} is missing the windows-support block`);
    }
});

test('RWP-002: all four languages agree on every canonical value', () => {
    // Assert VALUES, not prose. Phrase-presence checks break on rewording and would
    // not have caught the actual defect: four files stating different support levels.
    const expected: Record<string, string> = {
        'native-status': CONTRACT.nativeStatus,
        'preferred-path': CONTRACT.preferredPath,
        'node-floor': CONTRACT.nodeFloor,
        'manager-port': String(CONTRACT.managerPort),
        'runtime-port': String(CONTRACT.runtimePort),
        'registered-service': CONTRACT.registeredService,
        'install-command': CONTRACT.installCommand,
    };
    for (const file of READMES) {
        const block = parseWindowsBlock(read(file))!;
        for (const [key, value] of Object.entries(expected)) {
            assert.equal(block[key], value, `${file}: ${key} diverges from the canonical contract`);
        }
    }
});

test('RWP-003: the contract cannot drift from source', () => {
    // node-floor and registered-service ARE derivable from code, so pin them there.
    const pkg = JSON.parse(read('package.json'));
    assert.equal(`>=${CONTRACT.nodeFloor}`, pkg.engines.node);

    const serviceSrc = read('bin/commands/service.ts');
    const backends = serviceSrc.match(/VALID_BACKENDS = new Set\(\[(.*?)\]\)/)?.[1] ?? '';
    const claimsWindows = /windows|schtasks/i.test(backends);
    assert.equal(
        CONTRACT.registeredService === 'none', !claimsWindows,
        'registered-service must match whether a Windows backend actually exists',
    );
});

test('RWP-004: every README shows the install and recovery commands verbatim', () => {
    for (const file of READMES) {
        const text = read(file);
        assert.ok(text.includes(CONTRACT.installCommand), `${file} is missing the native installer command`);
        assert.ok(text.includes(CONTRACT.recoveryCommand), `${file} is missing the ${CONTRACT.recoveryCommand} recovery path`);
    }
});

test('RWP-005: no README still calls native Windows unsupported', () => {
    // The specific stale claim #373 reports: translations saying native PowerShell is
    // not a supported target while English advertises a beta installer.
    const stale = [/지원되는 CLI-JAW 설치 대상이 아닙니다/, /不是[^\n]*支持的安装目标/, /サポート対象[^\n]*ではありません/];
    for (const file of READMES) {
        const text = read(file);
        for (const pattern of stale) {
            assert.doesNotMatch(text, pattern, `${file} still says native Windows is unsupported`);
        }
    }
});

