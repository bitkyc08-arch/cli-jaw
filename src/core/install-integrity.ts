/**
 * install-integrity — is THIS installation complete?
 *
 * npm >= 12 blocks dependency lifecycle scripts by default, so a global
 * install can succeed while our postinstall never ran. The install-state
 * receipt written by scripts/postinstall-guard.cjs (or the sidecar bundler)
 * is the signal; everything else here turns that signal into a command the
 * user can actually paste.
 *
 * Two deliberately different files, two deliberately different schemas:
 *  - <installRoot>/.jaw-install-state.json — what the install's lifecycle
 *    script did (writers: postinstall-guard.cjs, bundle-sidecar.sh)
 *  - JAW_HOME/.setup-state.json — whether the user finished setup via
 *    `jaw init` (writer: bin/commands/init.ts). Lives in the user's home so
 *    a read-only global tree can still clear the warning.
 *
 * Both carry packageVersion: a receipt from a previous version never hides a
 * blocked upgrade (it degrades to `stale`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

export type PackageManager = 'npm' | 'pnpm' | 'bun' | 'unknown';
export type InstallScriptState = 'blocked' | 'safe-mode' | 'completed' | 'failed' | 'stale' | 'dev-clone';
export type PsExecutionPolicyState = 'skipped' | 'ok' | 'warn' | 'unknown';

export interface InstallStateReceipt {
    schema: number;
    state: string;
    packageVersion?: string;
    sidecar?: boolean;
    error?: string;
    ranAt?: string;
}

export interface SetupStateMarker {
    schema: number;
    packageVersion?: string;
    doneAt?: string;
}

export interface InstallIntegrity {
    installScriptState: InstallScriptState;
    userSetupDone: boolean;
    nativeLoadable: boolean;
    packageManager: PackageManager;
    installRoot: string;
    writableInstallTree: boolean;
    /** Packages whose install scripts this package needs approved. */
    scriptDependents: readonly string[];
}

export const SCRIPT_DEPENDENT_PACKAGES = ['cli-jaw'] as const;
export const INSTALL_STATE_FILE = '.jaw-install-state.json';
export const SETUP_STATE_FILE = '.setup-state.json';

function readJson(file: string): Record<string, unknown> | null {
    try {
        const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
        return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

export function readInstallState(installRoot: string): InstallStateReceipt | null {
    const raw = readJson(path.join(installRoot, INSTALL_STATE_FILE));
    if (!raw || typeof raw["state"] !== 'string') return null;
    return raw as unknown as InstallStateReceipt;
}

export function readSetupState(jawHome: string): SetupStateMarker | null {
    const raw = readJson(path.join(jawHome, SETUP_STATE_FILE));
    if (!raw || typeof raw["schema"] !== 'number') return null;
    return raw as unknown as SetupStateMarker;
}

export function writeSetupState(jawHome: string, packageVersion: string): void {
    fs.mkdirSync(jawHome, { recursive: true });
    fs.writeFileSync(path.join(jawHome, SETUP_STATE_FILE), JSON.stringify({
        schema: 1,
        packageVersion,
        doneAt: new Date().toISOString(),
    } satisfies SetupStateMarker, null, 2));
}

export function readPackageVersion(installRoot: string): string | null {
    const raw = readJson(path.join(installRoot, 'package.json'));
    return raw && typeof raw["version"] === 'string' ? raw["version"] : null;
}

/**
 * Which package manager owns this installation?
 * npm_config_user_agent is only present while the manager itself runs us, so
 * the install-root path is the durable signal for an installed CLI.
 */
export function detectPackageManager(
    installRoot: string,
    env: NodeJS.ProcessEnv = process.env,
): PackageManager {
    const agent = env["npm_config_user_agent"] || '';
    if (agent.startsWith('pnpm/')) return 'pnpm';
    if (agent.startsWith('bun')) return 'bun';
    if (agent.startsWith('npm/')) return 'npm';
    if (/[\\/]\.bun[\\/]/.test(installRoot)) return 'bun';
    if (/[\\/]pnpm[\\/]|[\\/]\.pnpm[\\/]/.test(installRoot)) return 'pnpm';
    if (installRoot) return 'npm';
    return 'unknown';
}

function canWriteInstallTree(installRoot: string): boolean {
    try {
        fs.accessSync(path.join(installRoot, 'node_modules'), fs.constants.W_OK);
        return true;
    } catch {
        return false;
    }
}

export function inspectInstallIntegrity(
    installRoot: string,
    jawHome: string,
    deps: { existsSync: (file: string) => boolean } = { existsSync: fs.existsSync },
): InstallIntegrity {
    const pkgVersion = readPackageVersion(installRoot);
    const receipt = readInstallState(installRoot);
    const setup = readSetupState(jawHome);

    let installScriptState: InstallScriptState;
    if (!receipt) {
        installScriptState = deps.existsSync(path.join(installRoot, '.git')) ? 'dev-clone' : 'blocked';
    } else if (pkgVersion && receipt.packageVersion !== pkgVersion) {
        installScriptState = 'stale';
    } else if (receipt.state === 'completed' || receipt.state === 'safe-mode' || receipt.state === 'failed') {
        installScriptState = receipt.state;
    } else {
        installScriptState = 'blocked';
    }

    const userSetupDone = Boolean(setup && pkgVersion && setup.packageVersion === pkgVersion);

    let nativeLoadable = true;
    try {
        const require_ = createRequire(path.join(installRoot, 'package.json'));
        const Database = require_('better-sqlite3') as new (name: string) => { close(): void };
        new Database(':memory:').close();
    } catch {
        nativeLoadable = false;
    }

    return {
        installScriptState,
        userSetupDone,
        nativeLoadable,
        packageManager: detectPackageManager(installRoot),
        installRoot,
        writableInstallTree: canWriteInstallTree(installRoot),
        scriptDependents: SCRIPT_DEPENDENT_PACKAGES,
    };
}

/**
 * Exact, working recovery commands. npm's own printed remediation omits the
 * package argument and fails with ENOENT (npm/cli#9835); never echo that form.
 * `--dangerously-allow-all-scripts` is deliberately never suggested.
 */
export function formatRecoveryCommands(
    integrity: InstallIntegrity,
    platform: NodeJS.Platform = process.platform,
): string[] {
    const allow = integrity.scriptDependents.join(',');
    switch (integrity.packageManager) {
        case 'bun':
            return ['bun add -g --trust cli-jaw'];
        case 'pnpm':
            return [
                `pnpm add -g --allow-build=${allow} cli-jaw`,
                'pnpm approve-builds -g   # pnpm <= 10',
            ];
        case 'npm':
            return [
                `npm install -g cli-jaw --allow-scripts=${allow}`,
                `npm config set allow-scripts=${allow} --location=user`,
                ...(platform === 'win32'
                    ? ['PowerShell: if jaw.ps1 is blocked, use jaw.cmd or node <prefix>\\node_modules\\cli-jaw\\dist\\bin\\cli-jaw.js']
                    : []),
            ];
        default:
            return [
                `npm install -g cli-jaw --allow-scripts=${allow}`,
                `pnpm add -g --allow-build=${allow} cli-jaw`,
                'bun add -g --trust cli-jaw',
            ];
    }
}

export interface PsExecutionPolicyResult {
    state: PsExecutionPolicyState;
    policy?: string;
    guidance?: string;
}

const PS_POLICY_GUIDANCE = [
    'Set-ExecutionPolicy -Scope CurrentUser RemoteSigned',
    'use jaw.cmd instead of jaw.ps1',
    'use node <prefix>\\node_modules\\cli-jaw\\dist\\bin\\cli-jaw.js',
].join('  |  ');

export function checkPsExecutionPolicy({
    platform = process.platform,
    runPolicy = () => execFileSync('powershell', ['-NoProfile', '-Command', 'Get-ExecutionPolicy'], {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 3000,
    }),
    runRegQuery = defaultRegQuery,
}: {
    platform?: NodeJS.Platform;
    runPolicy?: () => string;
    runRegQuery?: () => string;
} = {}): PsExecutionPolicyResult {
    if (platform !== 'win32') return { state: 'skipped' };
    try {
        const policy = runPolicy().trim();
        if (policy) return classifyPolicy(policy);
    } catch {
        // PS probe unavailable (e.g. security module cannot load under sshd)
    }
    try {
        const policy = runRegQuery().trim();
        if (policy) return classifyPolicy(policy);
    } catch {
        // both probes unavailable
    }
    return { state: 'unknown' };
}

function classifyPolicy(policy: string): PsExecutionPolicyResult {
    const normalized = policy.toLowerCase();
    if (['restricted', 'allsigned', 'undefined'].includes(normalized)) {
        return { state: 'warn', policy, guidance: PS_POLICY_GUIDANCE };
    }
    if (['remotesigned', 'bypass', 'unrestricted'].includes(normalized)) {
        return { state: 'ok', policy };
    }
    return { state: 'unknown', policy };
}

/** Registry fallback for hosts where the PS security module cannot load. */
function defaultRegQuery(): string {
    const keys = [
        'HKCU\\SOFTWARE\\Microsoft\\PowerShell\\1\\ShellIds\\Microsoft.PowerShell',
        'HKLM\\SOFTWARE\\Microsoft\\PowerShell\\1\\ShellIds\\Microsoft.PowerShell',
    ];
    for (const key of keys) {
        try {
            const out = execFileSync('reg', ['query', key, '/v', 'ExecutionPolicy'], {
                encoding: 'utf8',
                stdio: 'pipe',
                timeout: 3000,
            });
            const match = out.match(/ExecutionPolicy\s+REG_SZ\s+(\S+)/);
            if (match?.[1]) return match[1];
        } catch {
            // user-level absent or unreadable; try machine-level
        }
    }
    return '';
}

/** Problem → cause → command, Puppeteer-style. Plain text, pipe-safe. */
export function formatIntegrityReport(integrity: InstallIntegrity): string {
    const lines: string[] = [];
    if (integrity.installScriptState === 'failed') {
        lines.push('[jaw:install] the postinstall step ran but failed — run `jaw doctor` for details.');
    } else if (integrity.installScriptState === 'safe-mode') {
        lines.push('[jaw:install] this install used safe mode, so setup was skipped on purpose.');
        lines.push('[jaw:install] finish it with: jaw init');
        return lines.join('\n');
    } else {
        lines.push('[jaw:install] this installation is incomplete: the postinstall step never ran.');
        lines.push('[jaw:install] npm >= 12 blocks dependency install scripts unless allowed.');
    }
    lines.push('[jaw:install] fix it with one of:');
    for (const cmd of formatRecoveryCommands(integrity)) {
        lines.push(`[jaw:install]   ${cmd}`);
    }
    lines.push('[jaw:install] then re-run: jaw doctor');
    return lines.join('\n');
}
