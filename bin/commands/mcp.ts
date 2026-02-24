/**
 * cli-claw mcp — Phase 10
 * MCP server management: list, install, sync, reset.
 *
 * Usage:
 *   cli-claw mcp                       # list servers
 *   cli-claw mcp install <pkg>         # install npm/pypi package + add to mcp.json + sync
 *   cli-claw mcp sync                  # sync mcp.json → 4 CLI configs
 *   cli-claw mcp reset [--force]       # reset mcp.json to defaults + re-sync
 *
 * Package detection:
 *   npm:  @scope/name or name          → npm i -g <pkg>
 *   pypi: name (with --pypi flag)      → uv tool install <pkg> / pip install <pkg>
 *         or auto-detect by known prefixes (mcp-server-*)
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ─── lib imports (Single Source of Truth) ────
import {
    loadUnifiedMcp,
    saveUnifiedMcp,
    syncToAll,
    initMcpConfig,
} from '../../lib/mcp-sync.ts';

const CLAW_HOME = join(homedir(), '.cli-claw');

// ─── ANSI ────────────────────────────────────
const c = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    cyan: '\x1b[36m',
};

// ─── Helpers ─────────────────────────────────

function exec(cmd) {
    return execSync(cmd, { encoding: 'utf8', stdio: 'pipe', timeout: 120000 }).trim();
}

/** Read workingDir from settings.json for syncToAll() */
function getWorkingDir() {
    try {
        const settingsPath = join(CLAW_HOME, 'settings.json');
        return JSON.parse(readFileSync(settingsPath, 'utf8')).workingDir || homedir();
    } catch { return homedir(); }
}

// Known PyPI MCP packages (auto-detect without --pypi flag)
const PYPI_PATTERNS = [
    /^mcp-server-/,       // mcp-server-fetch, mcp-server-git, etc.
    /^mcp-/,
];

function detectEcosystem(pkg, forceFlag) {
    if (forceFlag === 'pypi') return 'pypi';
    if (forceFlag === 'npm') return 'npm';
    // Auto-detect
    if (pkg.startsWith('@')) return 'npm';  // @scope/name → npm
    if (PYPI_PATTERNS.some(p => p.test(pkg))) return 'pypi';
    return 'npm'; // default
}

function installNpm(pkg) {
    console.log(`  ${c.yellow}📦 npm i -g ${pkg}${c.reset}`);
    exec(`npm i -g ${pkg}`);
    // Find binary name: last segment of package name
    const binName = pkg.split('/').pop();
    let binPath;
    try { binPath = exec(`which ${binName}`); } catch { binPath = binName; }
    return { command: binName, args: [], bin: binPath };
}

function installPypi(pkg) {
    // Prefer uv tool install (faster), fallback to pip
    const hasUv = (() => { try { exec('which uv'); return true; } catch { return false; } })();
    if (hasUv) {
        console.log(`  ${c.yellow}📦 uv tool install ${pkg}${c.reset}`);
        try {
            exec(`uv tool install ${pkg}`);
        } catch {
            // uv tool install might fail if already installed, try upgrade
            try { exec(`uv tool upgrade ${pkg}`); } catch { }
        }
    } else {
        console.log(`  ${c.yellow}📦 pip install ${pkg}${c.reset}`);
        exec(`pip install ${pkg}`);
    }
    // Find binary: usually same as package name
    const binName = pkg;
    let binPath;
    try { binPath = exec(`which ${binName}`); } catch { binPath = binName; }
    return { command: binPath || binName, args: [], bin: binPath };
}

// ─── CLI Routing ─────────────────────────────
const sub = process.argv[3];
const arg = process.argv[4];

switch (sub) {
    case 'install': {
        if (!arg) {
            console.log(`\n  Usage: cli-claw mcp install <package> [--pypi|--npm]\n`);
            console.log(`  Examples:`);
            console.log(`    cli-claw mcp install @modelcontextprotocol/server-filesystem`);
            console.log(`    cli-claw mcp install mcp-server-fetch --pypi`);
            console.log(`    cli-claw mcp install @upstash/context7-mcp\n`);
            process.exit(1);
        }

        const forceFlag = process.argv.includes('--pypi') ? 'pypi'
            : process.argv.includes('--npm') ? 'npm' : null;
        const eco = detectEcosystem(arg, forceFlag);
        const config = loadUnifiedMcp();
        const serverName = arg.split('/').pop().replace(/^@/, '');

        console.log(`\n  ${c.bold}Installing ${arg}${c.reset} (${eco})\n`);

        try {
            const result = eco === 'pypi' ? installPypi(arg) : installNpm(arg);

            // Add to mcp.json
            config.servers[serverName] = {
                command: result.command,
                args: result.args,
            };
            saveUnifiedMcp(config);
            console.log(`  ${c.green}✅ Added to mcp.json:${c.reset} ${serverName}`);

            // Sync to all 4 CLIs
            syncToAll(config, getWorkingDir());
            console.log(`\n  ${c.green}Done!${c.reset} Server "${serverName}" ready for all CLIs.\n`);
        } catch (e) {
            console.error(`\n  ${c.red}❌ Install failed: ${e.message}${c.reset}\n`);
            process.exit(1);
        }
        break;
    }

    case 'sync': {
        const config = loadUnifiedMcp();
        console.log(`\n  ${c.bold}Syncing MCP config → all CLIs${c.reset}\n`);
        syncToAll(config, getWorkingDir());
        console.log('');
        break;
    }

    case 'reset': {
        const force = process.argv.includes('--force');
        if (!force) {
            const { createInterface } = await import('node:readline');
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            const answer = await new Promise(r => {
                rl.question(
                    `\n  ${c.yellow}⚠️  MCP 설정을 초기화합니다.${c.reset}\n` +
                    `  ~/.cli-claw/mcp.json이 재생성되고 4개 CLI에 재동기화됩니다.\n` +
                    `  계속하시겠습니까? (y/N): `, r
                );
            });
            rl.close();
            if (answer.toLowerCase() !== 'y') {
                console.log('  취소됨.\n');
                break;
            }
        }

        console.log(`\n  ${c.bold}🔄 MCP 설정 초기화 중...${c.reset}\n`);

        // 1. Delete existing mcp.json
        const mcpPath = join(CLAW_HOME, 'mcp.json');
        if (existsSync(mcpPath)) {
            unlinkSync(mcpPath);
            console.log(`  ${c.dim}✓ deleted ${mcpPath}${c.reset}`);
        }

        // 2. Re-init (import from workingDir/.mcp.json + DEFAULT_MCP_SERVERS merge)
        const workingDir = getWorkingDir();
        const config = initMcpConfig(workingDir);

        // 3. Re-sync to all CLIs
        const results = syncToAll(config, workingDir);

        const count = Object.keys(config.servers || {}).length;
        console.log(`\n  ${c.green}✅ 초기화 완료!${c.reset} (${count}개 서버)`);
        for (const [target, ok] of Object.entries(results)) {
            console.log(`  ${ok ? c.green + '✅' : c.dim + '⏭️ '} ${target}${c.reset}`);
        }
        console.log('');
        break;
    }

    case 'list':
    case undefined: {
        const config = loadUnifiedMcp();
        const entries = Object.entries(config.servers || {});
        console.log(`\n  ${c.bold}🔌 MCP Servers${c.reset} (${entries.length})\n`);
        if (!entries.length) {
            console.log(`  ${c.dim}(none)${c.reset}`);
        } else {
            for (const [name, srv] of entries) {
                const cmd = srv.args?.length
                    ? `${srv.command} ${srv.args.join(' ')}`
                    : srv.command;
                console.log(`  ${c.cyan}•${c.reset} ${c.bold}${name}${c.reset}  ${c.dim}${cmd}${c.reset}`);
            }
        }
        console.log(`\n  ${c.dim}cli-claw mcp install <pkg>  — 새 MCP 서버 설치${c.reset}`);
        console.log(`  ${c.dim}cli-claw mcp sync           — 4개 CLI에 동기화${c.reset}`);
        console.log(`  ${c.dim}cli-claw mcp reset          — 설정 초기화 + 재동기화${c.reset}\n`);
        break;
    }

    default:
        console.error(`  ${c.red}Unknown mcp subcommand: ${sub}${c.reset}`);
        console.log(`  Try: cli-claw mcp install <pkg>\n`);
        process.exit(1);
}
