import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
import { renderBlock } from '../../scripts/render-windows-support.mts';
// Normalize CRLF: a Windows checkout can materialize these files with CRLF, and the
// generator emits LF, so byte equality would fail for a line-ending difference that
// says nothing about the content contract.
const read = (p: string) => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n');

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
    const match = text.match(/<!-- windows-support:start[^\n]*\n([\s\S]*?)-->/);
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

/** The visible region between the marker comments — what a reader actually sees. */
function visibleBlock(text: string): string | null {
    const start = text.indexOf('-->', text.indexOf('<!-- windows-support:start'));
    const end = text.indexOf('<!-- windows-support:end -->');
    if (start < 0 || end < 0 || end < start) return null;
    return text.slice(start + 3, end);
}

test('RWP-006: the VISIBLE block states every canonical fact', () => {
    // RWP-002 alone was false-green: it compared hidden metadata to the contract, so a
    // README whose prose said 'fully stable' on ports 9999/8888 still passed. Readers
    // do not read the comment. Assert the rendered text.
    for (const file of READMES) {
        const text = read(file);
        const block = visibleBlock(text);
        assert.ok(block, `${file} has no visible windows-support region`);
        assert.ok(block!.includes(CONTRACT.installCommand), `${file}: installer command missing from the VISIBLE block`);
        assert.ok(block!.includes(CONTRACT.recoveryCommand), `${file}: ${CONTRACT.recoveryCommand} missing from the VISIBLE block`);
        assert.ok(block!.includes(CONTRACT.nodeFloor.replace(/\.0$/, '')), `${file}: Node floor missing from the VISIBLE block`);
        assert.ok(block!.includes(String(CONTRACT.managerPort)), `${file}: manager port missing from the VISIBLE block`);
        assert.ok(block!.includes(String(CONTRACT.runtimePort)), `${file}: runtime port missing from the VISIBLE block`);
        // 'beta' and the no-registered-service limitation must be visible too.
        assert.match(block!, /beta/i, `${file}: native status must be visible`);
        assert.match(block!, /jaw service install/, `${file}: the service limitation must be visible`);
    }
});

test('RWP-007: no README claims a wrong port or a stable native surface', () => {
    // Catch the mutation class directly rather than by exact obsolete phrasing.
    for (const file of READMES) {
        const block = visibleBlock(read(file))!;
        assert.doesNotMatch(block, /\b(9999|8888)\b/, `${file}: unexpected port in the Windows block`);
        assert.doesNotMatch(block, /Set-ExecutionPolicy\s+(Unrestricted|Bypass)/i,
            `${file}: must not recommend an unrestricted execution policy`);
    }
});

test('RWP-008: ports are pinned to source, not just to each other', () => {
    const config = read('src/core/config.ts');
    assert.ok(
        config.includes(String(CONTRACT.runtimePort)),
        'runtime port in the contract must appear in src/core/config.ts',
    );
    const manager = read('src/manager/constants.ts');
    assert.ok(
        manager.includes(String(CONTRACT.managerPort)),
        'manager port in the contract must appear in src/manager/constants.ts',
    );
});

test('RWP-009: jaw service install is never advertised without an OS scope', () => {
    // The block says native Windows has no registered backend; an unqualified
    // 'jaw service install # auto-start on boot' elsewhere in the same file
    // contradicts it. bin/commands/service.ts supports launchd/systemd/docker only.
    for (const file of READMES) {
        for (const line of read(file).split('\n')) {
            if (!line.includes('jaw service install')) continue;
            assert.match(
                line, /macOS|Linux|launchd|systemd/,
                `${file}: 'jaw service install' must name the platforms it supports — ${line.trim()}`,
            );
        }
    }
});

test('RWP-010: every README block EQUALS the generated output', () => {
    // This is the assertion that actually closes the oracle gap. RWP-006/007 could only
    // check for tokens they anticipated, so an adversarial block could claim WSL was
    // obsolete, native PowerShell stable, a wrong manager port, and Windows service
    // support while still containing every required token — and pass.
    //
    // Byte equality against the generator admits no such block: any hand-edit that
    // changes a fact, adds a contradictory sentence, or removes the limitation fails,
    // because the only accepted content is what the contract renders.
    const langs = { 'README.md': 'en', 'README.ko.md': 'ko', 'README.zh-CN.md': 'zh-CN', 'README.ja.md': 'ja' } as const;
    for (const [file, lang] of Object.entries(langs)) {
        const text = read(file);
        const start = text.indexOf('<!-- windows-support:start');
        const end = text.indexOf('<!-- windows-support:end -->');
        assert.ok(start >= 0 && end > start, `${file}: markers missing`);
        const actual = text.slice(start, end + '<!-- windows-support:end -->'.length);
        assert.equal(
            actual, renderBlock(lang as 'en' | 'ko' | 'zh-CN' | 'ja'),
            `${file}: the Windows block was hand-edited — run 'npx tsx scripts/render-windows-support.mts'`,
        );
    }
});

test('RWP-011: no README states a dashboard port that contradicts the contract', () => {
    // Outside the generated block, prose can still drift — Japanese told users to open
    // the runtime port for the manager dashboard. Anything naming the dashboard must
    // name the manager port.
    for (const file of READMES) {
        for (const line of read(file).split('\n')) {
            if (!/dashboard|대시보드|ダッシュボード|管理面板/i.test(line)) continue;
            if (!line.includes('localhost:')) continue;
            assert.ok(
                line.includes(String(CONTRACT.managerPort)),
                `${file}: a dashboard line names a port other than ${CONTRACT.managerPort} — ${line.trim()}`,
            );
        }
    }
});

test('RWP-012: policy fields drive VISIBLE prose, not just hidden metadata', () => {
    // A reviewer flipped preferredPath to native-powershell, regenerated, and all 11
    // tests passed while every visible block still recommended WSL — the metadata said
    // one thing and the prose said another. These assertions tie the rendered sentence
    // to the policy value, so the two cannot drift apart again.
    const block = renderBlock('en');
    if (CONTRACT.preferredPath === 'wsl') {
        assert.match(block, /WSL is the recommended, stable path/);
    } else {
        assert.match(block, /native PowerShell installer is the recommended path/i);
    }
    if (CONTRACT.registeredService === 'none') {
        assert.match(block, /no registered autostart backend/);
    } else {
        assert.match(block, new RegExp(CONTRACT.registeredService));
    }
});

test('RWP-013: the renderer EXECUTES its enum validation', () => {
    // Source-phrase matching was not enough: replacing both validation conditions with
    // `if (false)` left the phrases intact and this test still passed. Run the renderer
    // against invalid contracts instead and require a nonzero exit.
    const contractPath = join(root, 'scripts/windows-support-contract.json');
    const original = readFileSync(contractPath, 'utf8');
    try {
        for (const [field, bad] of [['preferredPath', 'not-a-path'], ['registeredService', 'not-a-backend']]) {
            const broken = { ...JSON.parse(original), [field]: bad };
            writeFileSync(contractPath, JSON.stringify(broken, null, 2));
            // On Windows, 'npx' is npx.cmd and spawnSync cannot execute it directly —
            // status and output both come back undefined, which made the assertion
            // compare 'undefinedundefined'. Run it through the platform's shell there.
            const run = spawnSync('npx', ['tsx', 'scripts/render-windows-support.mts', '--check'], {
                cwd: root, encoding: 'utf8', shell: process.platform === 'win32',
            });
            assert.notEqual(run.status, 0, `an invalid ${field} must abort the renderer`);
            assert.match(`${run.stderr}${run.stdout}`, new RegExp(`${field} must be one of`));
        }
    } finally {
        writeFileSync(contractPath, original);
    }
});
