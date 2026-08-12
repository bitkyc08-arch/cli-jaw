import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

import {
    HOST_TOOL_NAMES,
    HOST_TOOLCHAIN_PATH_CANDIDATE_LIMIT,
    HOST_TOOLCHAIN_PROMPT_BUDGET,
    type HostToolName,
    type HostToolchainProfile,
    isWindowsStorePythonRedirector,
    mergeHostToolchainProfileContent,
    parseHostToolchainProfile,
    renderHostToolchainManagedBlock,
    renderHostToolchainPromptBlock,
    resolveHostToolchainProfile,
} from '../../src/memory/host-toolchain.ts';
import { getAdvancedMemoryDir } from '../../src/memory/shared.ts';
import { scanSystemProfile } from '../../src/memory/bootstrap.ts';
import { getSystemPrompt } from '../../src/prompt/builder.ts';
import { settings } from '../../src/core/config.ts';

const FIRST_SCAN_AT = new Date('2026-08-12T01:00:00.000Z');
const RESTART_AT = new Date('2026-08-12T02:00:00.000Z');

function verifiedProfile(prefix = '/cached'): HostToolchainProfile {
    const tools = {} as HostToolchainProfile['tools'];
    for (const tool of HOST_TOOL_NAMES) {
        tools[tool] = {
            path: `${prefix}/${tool}`,
            version: '1.2.3',
            source: 'PATH',
            verified_at: FIRST_SCAN_AT.toISOString(),
            verification: 'verified',
        };
    }
    return {
        schema_version: 1,
        verified_at: FIRST_SCAN_AT.toISOString(),
        tools,
    };
}

test('first scan discovers and records verified absolute tool paths', () => {
    const discovered: HostToolName[] = [];
    const profile = resolveHostToolchainProfile(null, { platform: 'linux', workingDir: '/work' }, {
        now: () => FIRST_SCAN_AT,
        discover(tool) {
            discovered.push(tool);
            return { candidates: [{ path: `/opt/tools/${tool}`, source: 'PATH' }] };
        },
        verify: () => ({ ok: true, version: '9.8.7' }),
    });

    assert.deepEqual(discovered, [...HOST_TOOL_NAMES]);
    for (const tool of HOST_TOOL_NAMES) {
        assert.equal(profile.tools[tool].path, `/opt/tools/${tool}`);
        assert.equal(profile.tools[tool].verification, 'verified');
        assert.equal(profile.tools[tool].version, '9.8.7');
        assert.equal(profile.tools[tool].verified_at, FIRST_SCAN_AT.toISOString());
    }
});

test('PATH discovery verifies at most the bounded unique candidate count per tool', () => {
    const root = mkdtempSync(join(tmpdir(), 'jaw-host-toolchain-cap-'));
    const paths: string[] = [];
    const candidates = new Set<string>();
    try {
        for (let i = 0; i < HOST_TOOLCHAIN_PATH_CANDIDATE_LIMIT + 4; i++) {
            const dir = join(root, `candidate-${i}`);
            const candidate = join(dir, process.platform === 'win32' ? 'rg.cmd' : 'rg');
            mkdirSync(dir, { recursive: true });
            writeFileSync(candidate, process.platform === 'win32'
                ? '@echo off\r\necho ripgrep 1.0.0\r\n'
                : '#!/bin/sh\necho ripgrep 1.0.0\n', 'utf8');
            if (process.platform !== 'win32') chmodSync(candidate, 0o755);
            paths.push(dir);
            candidates.add(process.platform === 'win32' ? candidate.toLowerCase() : candidate);
        }

        const checked: string[] = [];
        const pathValue = paths.join(delimiter);
        resolveHostToolchainProfile(null, {
            platform: process.platform,
            env: process.platform === 'win32' ? { Path: pathValue, PATHEXT: '.CMD;.EXE' } : { PATH: pathValue },
            homeDir: root,
            workingDir: root,
        }, {
            now: () => FIRST_SCAN_AT,
            verify(tool, candidatePath) {
                const key = process.platform === 'win32' ? candidatePath.toLowerCase() : candidatePath;
                if (tool === 'ripgrep' && candidates.has(key)) checked.push(key);
                return { ok: false, missing: true };
            },
        });

        assert.equal(checked.length, HOST_TOOLCHAIN_PATH_CANDIDATE_LIMIT);
        assert.equal(new Set(checked).size, checked.length, 'PATH candidates remain deduplicated');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('restart fast-verifies cached paths without rediscovery', () => {
    const previous = verifiedProfile();
    const verified: string[] = [];
    const profile = resolveHostToolchainProfile(previous, { platform: 'linux', workingDir: '/work' }, {
        now: () => RESTART_AT,
        discover() {
            assert.fail('verified cached paths must skip discovery');
        },
        verify(tool, candidatePath) {
            verified.push(`${tool}:${candidatePath}`);
            return { ok: true, version: '1.2.4' };
        },
    });

    assert.equal(verified.length, HOST_TOOL_NAMES.length);
    assert.equal(profile.tools.officecli.path, '/cached/officecli');
    assert.equal(profile.tools.officecli.source, 'PATH');
    assert.equal(profile.tools.officecli.version, '1.2.4');
    assert.equal(profile.tools.officecli.verified_at, RESTART_AT.toISOString());
});

test('stale cached path falls back to discovery and replaces only that entry', () => {
    const previous = verifiedProfile();
    let officeDiscovery = 0;
    const profile = resolveHostToolchainProfile(previous, { platform: 'linux', workingDir: '/work' }, {
        now: () => RESTART_AT,
        discover(tool) {
            assert.equal(tool, 'officecli');
            officeDiscovery++;
            return { candidates: [{ path: '/new/officecli', source: 'known-location' }] };
        },
        verify(_tool, candidatePath) {
            return { ok: candidatePath !== '/cached/officecli', version: '2.0.0' };
        },
    });

    assert.equal(officeDiscovery, 1);
    assert.equal(profile.tools.officecli.path, '/new/officecli');
    assert.equal(profile.tools.officecli.source, 'known-location');
    assert.equal(profile.tools.soffice.path, '/cached/soffice');
});

test('Windows Store Python redirector is excluded and never verified as an interpreter', () => {
    const localAppData = 'C:\\Users\\operator\\AppData\\Local';
    const stub = `${localAppData}\\Microsoft\\WindowsApps\\python.exe`;
    let pythonVerifyCalls = 0;

    assert.equal(isWindowsStorePythonRedirector(stub, 'win32', { LOCALAPPDATA: localAppData }), true);
    const profile = resolveHostToolchainProfile(null, {
        platform: 'win32',
        workingDir: 'C:\\work',
        env: { LOCALAPPDATA: localAppData },
    }, {
        now: () => FIRST_SCAN_AT,
        discover(tool) {
            return { candidates: tool === 'python' ? [{ path: stub, source: 'PATH' }] : [] };
        },
        verify(tool) {
            if (tool === 'python') pythonVerifyCalls++;
            return { ok: false };
        },
    });

    assert.equal(pythonVerifyCalls, 0);
    assert.equal(profile.tools.python.path, null);
    assert.equal(profile.tools.python.verification, 'rejected-store-stub');
});

test('managed toolchain updates preserve curated and core-memory profile content', () => {
    const original = `---\nsource: curated\n---\n# Profile\n\n## Personal Context\n- Keep this\n\n<!-- cli-jaw:core-memory:start -->\n- Also keep core sync\n<!-- cli-jaw:core-memory:end -->\n`;
    const first = mergeHostToolchainProfileContent(original, verifiedProfile('/first'));
    const second = mergeHostToolchainProfileContent(first, verifiedProfile('/second'));

    assert.match(second, /## Personal Context\n- Keep this/);
    assert.match(second, /cli-jaw:core-memory:start/);
    assert.doesNotMatch(second, /\/first\/officecli/);
    assert.match(second, /\/second\/officecli/);
    assert.equal((second.match(/cli-jaw:host-toolchain:start/g) || []).length, 1);
    assert.equal(parseHostToolchainProfile(second)?.tools.ripgrep.path, '/second/ripgrep');
});

test('system scan seeds its profile with the durable managed toolchain section', () => {
    const previousWorkingDir = settings["workingDir"];
    settings["workingDir"] = process.cwd();
    let scanned: string;
    try {
        scanned = scanSystemProfile(verifiedProfile('/scan'));
    } finally {
        settings["workingDir"] = previousWorkingDir;
    }
    const parsed = parseHostToolchainProfile(scanned);

    assert.match(scanned, /## System/);
    assert.match(scanned, /## Runtime/);
    assert.equal(parsed?.tools.officecli.path, '/scan/officecli');
});

test('generated disk AGENTS has one short human-readable Host toolchain block', () => {
    const huge = verifiedProfile(`/${'x'.repeat(900)}`);
    const bounded = renderHostToolchainPromptBlock(huge);
    assert.ok(bounded.length <= HOST_TOOLCHAIN_PROMPT_BUDGET);
    assert.match(bounded, /^## Host toolchain/m);
    assert.doesNotMatch(bounded, /schema_version/);
    for (const budget of [-10, 0, 1, 5, 14, 15]) {
        assert.ok(
            renderHostToolchainPromptBlock(huge, budget).length <= Math.max(0, budget),
            `tiny prompt budget ${budget} must be honored exactly`,
        );
    }

    const profilePath = join(getAdvancedMemoryDir(), 'profile.md');
    mkdirSync(dirname(profilePath), { recursive: true });
    writeFileSync(profilePath, `# Profile\n\n## Curated\n- keep\n\n${renderHostToolchainManagedBlock(verifiedProfile('/verified'))}\n`, 'utf8');
    const prompt = getSystemPrompt({ forDisk: true });
    const refreshed = readFileSync(profilePath, 'utf8');
    const refreshedProfile = parseHostToolchainProfile(refreshed);

    assert.equal((prompt.match(/^## Host toolchain$/gm) || []).length, 1);
    assert.doesNotMatch(prompt, /\/verified\/officecli/, 'disk generation must not publish an unverified cached path');
    assert.notEqual(refreshedProfile?.verified_at, FIRST_SCAN_AT.toISOString());
    for (const tool of HOST_TOOL_NAMES) {
        const entry = refreshedProfile?.tools[tool];
        if (entry?.verification === 'verified') assert.ok(isAbsolute(entry.path || ''));
    }
    assert.doesNotMatch(prompt, /cli-jaw:host-toolchain:start/);
    assert.doesNotMatch(prompt, /schema_version/);

    getSystemPrompt({ forDisk: true });
    assert.equal(readFileSync(profilePath, 'utf8'), refreshed, 'fresh disk generations skip redundant subprocess probes');
});
