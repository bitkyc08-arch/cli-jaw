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

test('WB-011: resolveArch rejects the whole unsupported space, not four examples', () => {
    // A mutation that special-cased only the tested strings would pass a 4-example
    // list. Anything outside the supported set must throw.
    const supported = new Set(['x64', 'amd64', 'arm64']);
    for (const candidate of ['mips', 'riscv64', 'ppc64', 'x86', 'arm', 'ia64', 'X64 ', 'arm64x', '  ', 'null']) {
        if (supported.has(candidate.trim().toLowerCase())) continue;
        assert.throws(() => resolveArch(candidate), /unsupported Windows architecture/, `${candidate} must be rejected`);
    }
});

test('WB-012: the pinned digests are the exact upstream values', () => {
    // Shape checks (/^[0-9a-f]{64}$/) let any random hex pass, which would silently
    // break the gate forever. These four were fetched from nodejs.org SHASUMS256.txt
    // and the git-for-windows v2.55.0.windows.4 release body.
    const expected: Record<string, string> = {
        'node/x64': '57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73',
        'node/arm64': '8502f4a50b458d4cc38ed8f2001556c2cd239d464920f74017926ccb1e1c157f',
        'git/x64': '016e84230a3767f0c6b3788e79ba0c58a17377086801719d46700fca4f7b36b5',
        'git/arm64': 'd69d0c6a3c5445553565ef74f1d9e22a9869f57c246111db347dd96c252b4da5',
    };
    for (const tool of ['node', 'git'] as const) {
        for (const arch of ['x64', 'arm64'] as const) {
            assert.equal(planArtifact(MANIFEST, tool, arch, LOCAL).sha256, expected[`${tool}/${arch}`]);
        }
    }
});

test('WB-013: filenames are unique and the URL always contains its own filename', () => {
    const files = new Set<string>();
    for (const tool of ['node', 'git'] as const) {
        for (const arch of ['x64', 'arm64'] as const) {
            const plan = planArtifact(MANIFEST, tool, arch, LOCAL);
            assert.ok(!files.has(plan.file), `${plan.file} is reused across artifacts`);
            files.add(plan.file);
            // Coupling: a plan whose URL does not end in its own filename would
            // download one artifact and verify another's digest.
            assert.ok(plan.url.endsWith(plan.file), `${tool}/${arch}: url must end with its file`);
            assert.ok(plan.file.includes(arch === 'x64' ? '64' : 'arm64'));
            assert.ok(plan.installDir.endsWith(`\\${arch}`));
        }
    }
});

test('WB-014: digest comparison examines the WHOLE hash', () => {
    // A prefix-only comparison passes a naive tampering test. Flip a byte deep in the
    // payload so only late nibbles change.
    const bytes = Buffer.from('x'.repeat(4096));
    const digest = createHash('sha256').update(bytes).digest('hex');
    for (let i = 1; i <= 64; i++) {
        const hex = '0123456789abcdef';
        const pos = 64 - i;
        const ch = digest[pos]!;
        const swapped = hex[(hex.indexOf(ch) + 1) % 16]!;
        const wrong = digest.slice(0, pos) + swapped + digest.slice(pos + 1);
        assert.equal(verifyDigest(bytes, wrong), false, `a digest differing at position ${pos} must be rejected`);
    }
});

test('WB-015: bash candidates are rooted in the supplied git root', () => {
    const root1 = 'C:\\one\\git';
    const root2 = 'D:\\other\\git';
    for (const [gitRoot, other] of [[root1, root2], [root2, root1]] as const) {
        for (const candidate of bashCandidates(gitRoot)) {
            assert.ok(candidate.startsWith(gitRoot), `${candidate} must be under ${gitRoot}`);
            assert.ok(!candidate.startsWith(other));
        }
    }
});

test('WB-016: PATH merge dedupes within one call and preserves long existing lists', () => {
    // Duplicates supplied in a single call must collapse.
    const dup = mergeUserPath('C:\\A', ['C:\\New', 'C:\\new\\', 'C:\\New']);
    assert.equal(dup, 'C:\\A;C:\\New');
    // A longer list than any fixture, so truncation cannot hide.
    const many = Array.from({ length: 12 }, (_, i) => `C:\\P${i}`);
    const merged = mergeUserPath(many.join(';'), ['C:\\Owned']);
    assert.equal(merged.split(';').length, many.length + 1);
    assert.deepEqual(merged.split(';').slice(0, many.length), many);
});

test('WB-017: the receipt carries the plan identity, not just its URL', () => {
    const plan = planArtifact(MANIFEST, 'git', 'arm64', LOCAL);
    const receipt = buildReceipt(plan, '2026-08-15T00:00:00.000Z');
    assert.equal(receipt.tool, 'git');
    assert.equal(receipt.arch, 'arm64');
    assert.equal(receipt.installedAt, '2026-08-15T00:00:00.000Z');
    assert.equal(receipt.version, plan.version);
});

test('WB-018: the manifest records a real checksum source and no floating ref', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'scripts/windows-bootstrap-manifest.json'), 'utf8'));
    // Structural, not a substring of a comment.
    assert.match(manifest.node.checksumUrl, /SHASUMS256\.txt$/);
    for (const entry of [manifest.node, manifest.git]) {
        assert.doesNotMatch(entry.urlTemplate, /latest/, 'no floating ref may appear in a pinned template');
    }
    assert.match(manifest.git.tag, /^v\d+\.\d+\.\d+\.windows\.\d+$/);
});

test('WB-019: the installer exposes a real opt-in switch, not just a plan', () => {
    // A reviewer correctly called the first draft 'disconnected groundwork': the
    // helpers existed with no production call site, so 'opt-in' meant 'absent'.
    const src = readFileSync(join(root, 'scripts/install.ps1'), 'utf8');
    assert.match(src, /\[switch\]\$BootstrapDependencies/);
    assert.match(src, /\[switch\]\$WithPortableGit/);
    assert.match(src, /\[switch\]\$DryRun/);
    // And it must actually gate the missing-Node branch.
    assert.match(src, /if \(\$BootstrapDependencies -or \$DryRun\)/);
    assert.match(src, /Install-BootstrapTool -Tool 'node'/);
});

test('WB-020: the download transaction verifies BEFORE it extracts', () => {
    // Extraction runs attacker-controlled bytes through an archive parser, so a
    // hash checked afterwards is not a gate.
    const src = readFileSync(join(root, 'scripts/install.ps1'), 'utf8');
    const fn = src.slice(src.indexOf('function Install-BootstrapTool'));
    const hashIdx = fn.indexOf('Get-FileHash');
    const mismatchIdx = fn.indexOf('checksum mismatch');
    const extractIdx = fn.indexOf('Expand-Archive');
    assert.ok(hashIdx > 0 && mismatchIdx > 0 && extractIdx > 0, 'hash, mismatch guard, and extract must all exist');
    assert.ok(hashIdx < extractIdx, 'the digest must be computed before extraction');
    assert.ok(mismatchIdx < extractIdx, 'the mismatch guard must abort before extraction');
});

test('WB-021: promotion is atomic and the receipt is written last', () => {
    const src = readFileSync(join(root, 'scripts/install.ps1'), 'utf8');
    const fn = src.slice(src.indexOf('function Install-BootstrapTool'));
    const probeIdx = fn.indexOf('did not produce the expected binary');
    const moveIdx = fn.indexOf('Move-Item');
    const receiptIdx = fn.indexOf('installedAt =');
    assert.ok(probeIdx > 0 && moveIdx > 0 && receiptIdx > 0);
    assert.ok(probeIdx < moveIdx, 'the binary must be probed before the tree is published');
    assert.ok(moveIdx < receiptIdx, 'the receipt must not exist for an unpromoted tree');
    // Staging must be cleaned on every path, so a failure leaves no half install.
    assert.match(fn, /finally \{[\s\S]*Remove-Item -LiteralPath \$staging -Recurse -Force/);
});

test('WB-022: re-running is a no-op once the receipt exists', () => {
    const src = readFileSync(join(root, 'scripts/install.ps1'), 'utf8');
    const fn = src.slice(src.indexOf('function Install-BootstrapTool'));
    assert.match(fn, /if \(Test-Path -LiteralPath \$receiptPath\)/);
    assert.match(fn, /already provisioned/);
});

test('WB-023: bootstrap never force-writes the User PATH', () => {
    // The installer's stated contract is that it prints PATH changes rather than
    // making them. Bootstrapping must not quietly break that promise.
    const src = readFileSync(join(root, 'scripts/install.ps1'), 'utf8');
    const fn = src.slice(src.indexOf('function Install-BootstrapTool'), src.indexOf('# --- 1. Node.js'));
    assert.doesNotMatch(fn, /SetEnvironmentVariable/, 'bootstrap must not persist PATH itself');
});

test('WB-024: the native architecture is used, not the process architecture', () => {
    const src = readFileSync(join(root, 'scripts/install.ps1'), 'utf8');
    // PROCESSOR_ARCHITECTURE reports x64 for an emulated process on an ARM64 host,
    // which would download the wrong runtime.
    assert.match(src, /RuntimeInformation\]::OSArchitecture/);
    // Only CODE counts — the resolver explains in a comment why it avoids
    // PROCESSOR_ARCHITECTURE, and that explanation should survive refactors.
    // Normalize CRLF first: install.ps1 is CRLF, and `.` does not match `\r`, so
    // `#.*$` silently fails to strip anything on a line ending in \r\n.
    const stripComments = (s: string) =>
        s.replace(/\r\n/g, '\n').split('\n').map(l => l.replace(/#.*$/, '')).join('\n');
    const arch = stripComments(src.slice(src.indexOf('function Resolve-NativeArch'), src.indexOf('function Install-BootstrapTool')));
    assert.doesNotMatch(arch, /PROCESSOR_ARCHITECTURE/, 'the arch resolver must not read the process architecture');
    const bootstrapFn = stripComments(src.slice(src.indexOf('function Install-BootstrapTool'), src.indexOf('# --- 1. Node.js')));
    assert.doesNotMatch(bootstrapFn, /PROCESSOR_ARCHITECTURE/);
});
