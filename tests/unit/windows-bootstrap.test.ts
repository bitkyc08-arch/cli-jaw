import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    resolveArch, planArtifact, verifyDigest, bashCandidates, mergeUserPath,
    buildReceipt, loadManifest,
} from '../../src/core/windows-bootstrap.ts';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const MANIFEST = loadManifest(join(root, 'scripts/windows-bootstrap-manifest.json'));
const LOCAL = 'C:\\Users\\jun\\AppData\\Local';

test('WB-001: architecture maps only to supported values and fails loudly otherwise', () => {
    assert.equal(resolveArch('X64'), 'x64');
    assert.equal(resolveArch('Arm64'), 'arm64');
    assert.equal(resolveArch('AMD64'), 'x64');
    // 32-bit and unknown values must not silently fall back to x64 — that would
    // download an artifact the machine cannot run.
    for (const bad of ['X86', 'ARM', 'ia64', '']) {
        assert.throws(() => resolveArch(bad), /unsupported Windows architecture/);
    }
});

test('WB-002: the plan pins tag, filename, and digest together', () => {
    const plan = planArtifact(MANIFEST, 'node', 'x64', LOCAL);
    assert.equal(plan.file, 'node-v24.19.0-win-x64.zip');
    assert.equal(plan.url, 'https://nodejs.org/dist/v24.19.0/node-v24.19.0-win-x64.zip');
    assert.match(plan.sha256, /^[0-9a-f]{64}$/);
    assert.equal(plan.installDir, 'C:\\Users\\jun\\AppData\\Local\\cli-jaw\\runtimes\\node\\24.19.0\\x64');
    // A moving URL would make the digest meaningless.
    assert.doesNotMatch(plan.url, /latest\/download/);
});

test('WB-003: the Git artifact is PortableGit, which actually ships bash', () => {
    const plan = planArtifact(MANIFEST, 'git', 'arm64', LOCAL);
    assert.match(plan.file, /^PortableGit-/);
    // MinGit is smaller but has no bash, so it cannot satisfy the Git Bash requirement.
    assert.doesNotMatch(plan.file, /MinGit/);
    assert.equal(plan.url, 'https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.4/PortableGit-2.55.0.4-arm64.7z.exe');
});

test('WB-004: every pinned artifact has a full-length digest and a distinct file', () => {
    const seen = new Set<string>();
    for (const tool of ['node', 'git'] as const) {
        for (const arch of ['x64', 'arm64'] as const) {
            const plan = planArtifact(MANIFEST, tool, arch, LOCAL);
            assert.match(plan.sha256, /^[0-9a-f]{64}$/, `${tool}/${arch} needs a sha256`);
            assert.ok(!seen.has(plan.sha256), `${tool}/${arch} reuses another artifact's digest`);
            seen.add(plan.sha256);
        }
    }
});

test('WB-005: digest verification accepts the real bytes and rejects a single flipped bit', () => {
    const bytes = Buffer.from('pretend this is a runtime archive');
    const digest = createHash('sha256').update(bytes).digest('hex');
    assert.equal(verifyDigest(bytes, digest), true);
    assert.equal(verifyDigest(bytes, digest.toUpperCase()), true, 'hex casing must not matter');
    const tampered = Buffer.from(bytes);
    tampered[0] ^= 0x01;
    assert.equal(verifyDigest(tampered, digest), false, 'a mutated artifact must be rejected');
    assert.equal(verifyDigest(bytes, ''), false, 'an empty expectation must never pass');
});

test('WB-006: both PortableGit bash layouts are considered', () => {
    const candidates = bashCandidates('C:\\Users\\jun\\AppData\\Local\\cli-jaw\\runtimes\\git\\2.55.0.4\\x64');
    assert.equal(candidates.length, 2);
    assert.ok(candidates.some(c => c.endsWith('\\bin\\bash.exe')));
    assert.ok(candidates.some(c => c.endsWith('\\usr\\bin\\bash.exe')));
});

test('WB-007: PATH merge is idempotent and case-insensitive', () => {
    const user = 'C:\\Existing;C:\\Tools';
    const owned = ['C:\\Users\\jun\\AppData\\Local\\cli-jaw\\runtimes\\node\\24.19.0\\x64'];
    const once = mergeUserPath(user, owned);
    assert.equal(once, `${user};${owned[0]}`);
    // Re-running the installer must not grow PATH.
    assert.equal(mergeUserPath(once, owned), once);
    // Windows PATH lookup is case-insensitive: c:\\tools is already C:\\Tools.
    assert.equal(mergeUserPath(user, ['c:\\tools\\']), user);
});

test('WB-008: the merge never drops or reorders existing entries', () => {
    const user = 'C:\\A;C:\\B;C:\\C';
    const merged = mergeUserPath(user, ['C:\\New']);
    assert.equal(merged.split(';').slice(0, 3).join(';'), user, 'existing entries keep order and spelling');
});

test('WB-009: the receipt records provenance, not just a path', () => {
    const plan = planArtifact(MANIFEST, 'node', 'x64', LOCAL);
    const receipt = buildReceipt(plan, '2026-08-15T00:00:00.000Z');
    // Provenance is the point: without url+sha256 a receipt cannot prove WHAT was run.
    assert.equal(receipt.url, plan.url);
    assert.equal(receipt.sha256, plan.sha256);
    assert.equal(receipt.installDir, plan.installDir);
    assert.equal(receipt.version, '24.19.0');
});

test('WB-010: the manifest never uses a moving download URL', () => {
    const raw = readFileSync(join(root, 'scripts/windows-bootstrap-manifest.json'), 'utf8');
    // 'latest/download' resolves to whatever ships next, so the pinned digest could
    // never match it — the gate would be permanently broken rather than strict.
    assert.doesNotMatch(raw, /releases\/latest\/download/, 'a moving URL makes the pinned digest unenforceable');
    assert.match(raw, /SHASUMS256\.txt/, 'the reproducible Node checksum source must be recorded');
});
