#!/usr/bin/env node
/**
 * cli-jaw — Phase 9.1
 * CLI entrypoint with subcommand routing.
 * No external dependencies — Node built-in only.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
let pkg: any;
try {
    const pkgPath = join(__dirname, '..', 'package.json');
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
} catch {
    const pkgPath = join(__dirname, '..', '..', 'package.json');
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
}

// ─── --home flag: must run BEFORE command parsing (ESM hoisting safe) ───
// Manual parsing instead of parseArgs to avoid absorbing subcommand flags
const _homeIdx = process.argv.indexOf('--home');
const _homeEqArg = process.argv.find(a => a.startsWith('--home='));
if (_homeIdx !== -1 && process.argv[_homeIdx + 1]) {
    const _homeVal = process.argv[_homeIdx + 1]!;
    // Guard: if the "value" looks like a known subcommand, user forgot the path
    const _knownCmds = ['serve', 'init', 'doctor', 'chat', 'employee', 'reset', 'mcp', 'skill', 'status', 'browser', 'memory', 'launchd', 'clone', 'service', 'orchestrate'];
    if (_knownCmds.includes(_homeVal)) {
        console.error(`  ❌ --home requires a path argument (got subcommand '${_homeVal}')`);
        console.error(`  Usage: jaw --home <path> ${_homeVal}`);
        process.exit(1);
    }
    process.env.CLI_JAW_HOME = resolve(
        _homeVal.replace(/^~(?=\/|$)/, homedir())
    );
    process.argv.splice(_homeIdx, 2);
} else if (_homeIdx !== -1 && !process.argv[_homeIdx + 1]) {
    console.error('  ❌ --home requires a path argument');
    console.error('  Usage: jaw --home <path> <command>');
    process.exit(1);
} else if (_homeEqArg) {
    const val = _homeEqArg.slice('--home='.length);
    process.env.CLI_JAW_HOME = resolve(val.replace(/^~(?=\/|$)/, homedir()));
    process.argv.splice(process.argv.indexOf(_homeEqArg), 1);
}

const command = process.argv[2];

function printHelp() {
    const c = { cyan: '\x1b[36m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' };
    console.log(`
${c.cyan}     _____ _      _____       _                 
    / ____| |    |_   _|     | |                
   | |    | |      | |       | | __ ___      __ 
   | |    | |      | |   _   | |/ _\` \\ \\ /\\ / / 
   | |____| |____ _| |_ | |__| | (_| |\\ V  V /  
    \\_____|______|_____| \\____/ \\__,_| \\_/\\_/   ${c.reset}
${c.dim}   ─────────────────────────────────────${c.reset}
${c.bold}   🦈 v${pkg.version}${c.reset}  ${c.dim}AI Agent Orchestration Platform${c.reset}

  ${c.bold}Usage:${c.reset}  jaw <command> [options]

  ${c.bold}Commands:${c.reset}
    serve      서버 시작 (포그라운드)
    init       초기 설정 마법사
    doctor     설치/설정 진단
    chat       터미널 채팅 (REPL)
    employee   직원 관리 (reset)
    reset      전체 초기화 (MCP/스킬/직원/세션)
    mcp        MCP 서버 관리 (install/sync/list)
    skill      스킬 관리 (install/remove/info)
    status     서버 상태 확인
    browser    브라우저 제어
    memory     영구 메모리 관리
    launchd    macOS 자동 실행 관리 (install/uninstall/status)
    service    크로스 플랫폼 자동 실행 (systemd/launchd/docker)
    clone      인스턴스 복제 (독립 에이전트 생성)
    orchestrate PABCD 상태 전환 (P|A|B|C|D)

  ${c.bold}Options:${c.reset}
    --home     데이터 디렉토리 지정 (기본: ~/.cli-jaw)
    --help     도움말 표시
    --version  버전 표시

  ${c.bold}Examples:${c.reset}
    jaw serve
    jaw serve --home ~/.jaw-work --port 3458
    jaw init
    jaw doctor --json
`);
}

switch (command) {
    case 'serve':
        await import('./commands/serve.js');
        break;
    case 'init':
        await import('./commands/init.js');
        break;
    case 'doctor':
        await import('./commands/doctor.js');
        break;
    case 'chat':
        await import('./commands/chat.js');
        break;
    case 'employee':
        await import('./commands/employee.js');
        break;
    case 'reset':
        await import('./commands/reset.js');
        break;
    case 'mcp':
        await import('./commands/mcp.js');
        break;
    case 'skill':
        await import('./commands/skill.js');
        break;
    case 'status':
        await import('./commands/status.js');
        break;
    case 'browser':
        await import('./commands/browser.js');
        break;
    case 'memory':
        await import('./commands/memory.js');
        break;
    case 'launchd':
        await import('./commands/launchd.js');
        break;
    case 'clone':
        await import('./commands/clone.js');
        break;
    case 'orchestrate':
        await import('./commands/orchestrate.js');
        break;
    case 'service':
        await import('./commands/service.js');
        break;
    case '--version':
    case '-v':
        console.log(`cli-jaw v${pkg.version}`);
        break;
    case '--help':
    case '-h':
    case undefined:
        printHelp();
        break;
    default:
        console.error(`  ❌ Unknown command: ${command}\n`);
        printHelp();
        process.exitCode = 1;
        break;
}
