/** Explicit controlled-launch policy. Importing this module performs no I/O.
 * The supervisor owns environment construction BEFORE DB-bearing imports.
 * This is not an OS sandbox for arbitrary commands or hostile same-user changes.
 */
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export type IsolatedQaRole = 'worker' | 'manager' | 'electron';
export interface IsolatedQaPolicy {
    readonly root: string;
    readonly role: IsolatedQaRole;
    readonly home: string;
    readonly temporary: string;
    readonly jawHome: string;
    readonly dashboardHome: string;
    readonly workerPort: number;
    readonly managerPort: number;
    readonly previewPort: number;
    readonly managerUrl: string;
    readonly electron: Readonly<{ userData: string; sessionData: string; logs: string; crashDumps: string }>;
}

const ROOT_KEY = 'CLI_JAW_ISOLATED_QA_ROOT';
const ROOTS = {
    HOME: 'home', TMPDIR: 'tmp', XDG_CONFIG_HOME: 'xdg/config', XDG_CACHE_HOME: 'xdg/cache',
    XDG_DATA_HOME: 'xdg/data', XDG_STATE_HOME: 'xdg/state', CLI_JAW_DASHBOARD_HOME: 'dashboard',
    CODEX_HOME: 'providers/codex', CLAUDE_CONFIG_DIR: 'providers/claude', PI_CODING_AGENT_DIR: 'providers/pi',
} as const;
const WINDOWS_ROOTS = { USERPROFILE: 'home', APPDATA: 'xdg/data', LOCALAPPDATA: 'xdg/cache' } as const;
// GUI/OS connection fields are admitted by the trusted supervisor, not recovered
// from a login shell. No arbitrary prefix, provider credential or NODE_OPTIONS.
const BOOTSTRAP_KEYS = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM',
    'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS',
    'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'ComSpec', 'PATHEXT', '__CF_USER_TEXT_ENCODING'] as const;

function invalid(field: string, reason: string): never {
    throw Object.assign(new Error(`isolated_qa_invalid: ${field} ${reason}`), { code: 'isolated_qa_invalid', statusCode: 400 });
}
function directory(value: string | undefined, field: string): string {
    if (!value || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)
        || !path.isAbsolute(value) || path.resolve(value) !== value) invalid(field, 'requires a canonical absolute directory');
    try {
        if (realpathSync.native(value) !== value || !statSync(value).isDirectory()) invalid(field, 'must be a real directory');
    } catch { invalid(field, 'must be an existing canonical directory'); }
    return value;
}
function childDirectory(root: string, suffix: string): string {
    const value = path.join(root, suffix);
    const relative = path.relative(root, value);
    if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) invalid('layout', 'escapes task root');
    return directory(value, suffix);
}
function port(env: NodeJS.ProcessEnv, key: string): number {
    const value = env[key];
    if (!value || !/^[1-9]\d{0,4}$/u.test(value)) invalid(key, 'requires an explicit decimal port');
    const result = Number(value);
    if (result > 65535) invalid(key, 'is outside the port range');
    return result;
}

export function readIsolatedQaPolicy(env: NodeJS.ProcessEnv, role: IsolatedQaRole): IsolatedQaPolicy | null {
    if (!Object.prototype.hasOwnProperty.call(env, ROOT_KEY)) return null;
    const root = directory(env[ROOT_KEY], ROOT_KEY);
    if (root === path.parse(root).root) invalid(ROOT_KEY, 'cannot be filesystem root');
    for (const [key, suffix] of Object.entries(ROOTS)) {
        const expected = childDirectory(root, suffix);
        if (env[key] !== expected) invalid(key, 'does not match task layout');
    }
    for (const [key, suffix] of Object.entries(WINDOWS_ROOTS)) {
        if (env[key] !== undefined && env[key] !== path.join(root, suffix)) invalid(key, 'does not match task layout');
    }
    const workerHome = childDirectory(root, 'worker');
    const managerHome = childDirectory(root, 'manager');
    const jawHome = role === 'worker' ? workerHome : managerHome;
    if (env['CLI_JAW_HOME'] !== jawHome) invalid('CLI_JAW_HOME', 'does not match role');
    const workerPort = port(env, 'DASHBOARD_SCAN_FROM');
    const managerPort = port(env, 'DASHBOARD_PORT');
    const previewPort = port(env, 'DASHBOARD_PREVIEW_FROM');
    if (env['DASHBOARD_SCAN_COUNT'] !== '1') invalid('DASHBOARD_SCAN_COUNT', 'must be exactly one');
    if (new Set([workerPort, managerPort, previewPort]).size !== 3) invalid('ports', 'must be distinct');
    if (role === 'worker' && port(env, 'PORT') !== workerPort) invalid('PORT', 'does not match worker');
    const electron = Object.freeze({ userData: childDirectory(root, 'electron/userData'),
        sessionData: childDirectory(root, 'electron/sessionData'), logs: childDirectory(root, 'electron/logs'),
        crashDumps: childDirectory(root, 'electron/crashDumps') });
    return Object.freeze({ root, role, home: path.join(root, 'home'), temporary: path.join(root, 'tmp'),
        jawHome, dashboardHome: path.join(root, 'dashboard'), workerPort, managerPort, previewPort,
        managerUrl: `http://127.0.0.1:${managerPort}/`, electron });
}

export function isolatedQaEnvironment(policy: IsolatedQaPolicy, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const executablePath = source['PATH'];
    if (!executablePath || /[\u0000-\u001f\u007f]/u.test(executablePath)
        || executablePath.split(path.delimiter).some(entry => !path.isAbsolute(entry))) invalid('PATH', 'requires approved absolute entries');
    const env: NodeJS.ProcessEnv = {};
    for (const key of BOOTSTRAP_KEYS) {
        const value = source[key];
        if (value !== undefined) {
            if (/[\u0000-\u001f\u007f]/u.test(value)) invalid(key, 'contains control characters');
            env[key] = value;
        }
    }
    for (const [key, suffix] of Object.entries({ ...ROOTS, ...WINDOWS_ROOTS })) env[key] = path.join(policy.root, suffix);
    env[ROOT_KEY] = policy.root;
    env['CLI_JAW_HOME'] = policy.jawHome;
    env['DASHBOARD_PORT'] = String(policy.managerPort);
    env['DASHBOARD_SCAN_FROM'] = String(policy.workerPort);
    env['DASHBOARD_SCAN_COUNT'] = '1';
    env['DASHBOARD_PREVIEW_FROM'] = String(policy.previewPort);
    if (policy.role === 'worker') env['PORT'] = String(policy.workerPort);
    env['CLI_JAW_SKIP_AUTOMATION_PRIME'] = '1';
    env['JAW_OPEN_BROWSER'] = '0'; env['JAW_DASHBOARD_OPEN'] = '0';
    env['JAW_SKILLS_SOURCE'] = 'local'; env['NO_COLOR'] = '1';
    // Required by the existing Electron->manager embedded-browser boundary.
    // Initial supervisors remove inherited values; Electron supplies its freshly
    // generated randomBytes(32) token before invoking this constructor.
    const token = source['CLI_JAW_ELECTRON_RENDERER_TOKEN'];
    if (token !== undefined) {
        if (!/^[a-f0-9]{64}$/u.test(token)) invalid('CLI_JAW_ELECTRON_RENDERER_TOKEN', 'is not a task token');
        env['CLI_JAW_ELECTRON_RENDERER_TOKEN'] = token;
    }
    return env;
}

export function assertIsolatedQaScan(policy: IsolatedQaPolicy | null, from: number, count: number): void {
    if (policy && (from !== policy.workerPort || count !== 1)) {
        throw Object.assign(new Error('isolated_qa_scan_forbidden'), { code: 'isolated_qa_scan_forbidden', statusCode: 403 });
    }
}
