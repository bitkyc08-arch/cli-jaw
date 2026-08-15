import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { win32 as pathWin32 } from 'node:path';

/**
 * Planning and verification for the non-admin Windows bootstrap (#369).
 *
 * The download itself is PowerShell's job. Everything that can be decided without a
 * network — which artifact, which URL, where it lands, what the PATH becomes, whether a
 * digest matches — lives here as pure functions, so the risky part of a supply-chain
 * feature is unit-tested on any platform instead of only on a Windows runner.
 *
 * Activation is deliberately opt-in (`-BootstrapDependencies`). Turning it on by
 * default in a command users paste from a README is a product decision, not an
 * implementation detail: it cannot be walked back per-user once shipped.
 */
export type BootstrapArch = 'x64' | 'arm64';
export type BootstrapTool = 'node' | 'git';

export type ArtifactPlan = {
    tool: BootstrapTool;
    version: string;
    arch: BootstrapArch;
    file: string;
    url: string;
    sha256: string;
    /** Where the verified artifact is promoted to, under LOCALAPPDATA. */
    installDir: string;
};

type Manifest = {
    node: ManifestEntry;
    git: ManifestEntry;
};
type ManifestEntry = {
    version: string;
    tag?: string;
    urlTemplate: string;
    artifacts: Record<string, { file: string; sha256: string }>;
};

export function loadManifest(path: string): Manifest {
    return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

/**
 * Map a reported processor architecture onto a supported artifact.
 *
 * An ARM64 Windows host can run an x64 PowerShell under emulation, so the value that
 * matters is the NATIVE architecture. Callers must pass
 * `[Runtime.InteropServices.RuntimeInformation]::OSArchitecture`, not PROCESSOR_ARCHITECTURE.
 * Anything unrecognized fails loudly rather than guessing x64.
 */
export function resolveArch(osArchitecture: string): BootstrapArch {
    const normalized = String(osArchitecture || '').trim().toLowerCase();
    if (normalized === 'x64' || normalized === 'amd64') return 'x64';
    if (normalized === 'arm64') return 'arm64';
    throw new Error(`unsupported Windows architecture: ${osArchitecture || '(empty)'}`);
}

export function planArtifact(
    manifest: Manifest,
    tool: BootstrapTool,
    arch: BootstrapArch,
    localAppData: string,
): ArtifactPlan {
    const entry = manifest[tool];
    const artifact = entry.artifacts[arch];
    if (!artifact) throw new Error(`${tool} has no pinned artifact for ${arch}`);
    const url = entry.urlTemplate
        .replace(/\{version\}/g, entry.version)
        .replace(/\{tag\}/g, entry.tag ?? '')
        .replace(/\{arch\}/g, arch)
        .replace(/\{file\}/g, artifact.file);
    return {
        tool,
        version: entry.version,
        arch,
        file: artifact.file,
        url,
        sha256: artifact.sha256,
        installDir: pathWin32.join(localAppData, 'cli-jaw', 'runtimes', tool, entry.version, arch),
    };
}

/** Digest check. Case-insensitive because tooling disagrees on hex casing. */
export function verifyDigest(bytes: Buffer, expectedSha256: string): boolean {
    const actual = createHash('sha256').update(bytes).digest('hex');
    return actual.toLowerCase() === String(expectedSha256 || '').toLowerCase();
}

/**
 * Candidate bash paths for a PortableGit root.
 *
 * PortableGit ships bash at BOTH layouts depending on version and packaging, and
 * checking only `bin\\bash.exe` is why an installed Git can read as missing.
 */
export function bashCandidates(gitRoot: string): string[] {
    return [
        pathWin32.join(gitRoot, 'bin', 'bash.exe'),
        pathWin32.join(gitRoot, 'usr', 'bin', 'bash.exe'),
    ];
}

/**
 * Merge cli-jaw-owned directories into an existing User PATH.
 *
 * Only the User target is ever touched, entries are compared case-insensitively (a
 * Windows path is case-insensitive, so `C:\\Tools` and `c:\\tools` are one directory),
 * and existing entries keep their original order and spelling. Re-running must be a
 * no-op, which is what makes the installer safe to run twice.
 */
export function mergeUserPath(userPath: string, ownedDirs: string[]): string {
    const existing = String(userPath || '').split(';').filter(Boolean);
    const seen = new Set(existing.map(e => e.replace(/[\\/]+$/, '').toLowerCase()));
    const additions: string[] = [];
    for (const dir of ownedDirs) {
        const key = dir.replace(/[\\/]+$/, '').toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        additions.push(dir);
    }
    return [...existing, ...additions].join(';');
}

/** The install receipt, written only AFTER the extracted binary probes successfully. */
export type InstallReceipt = {
    tool: BootstrapTool;
    version: string;
    arch: BootstrapArch;
    installDir: string;
    sha256: string;
    url: string;
    installedAt: string;
};

export function buildReceipt(plan: ArtifactPlan, installedAt: string): InstallReceipt {
    return {
        tool: plan.tool,
        version: plan.version,
        arch: plan.arch,
        installDir: plan.installDir,
        sha256: plan.sha256,
        url: plan.url,
        installedAt,
    };
}

