/**
 * cli-claw skill — Phase 12.1.6
 * Skill management: list, install, remove, info.
 *
 * Usage:
 *   cli-claw skill                    # list installed skills
 *   cli-claw skill install <name>     # install from Codex or GitHub
 *   cli-claw skill remove <name>      # delete a skill
 *   cli-claw skill info <name>        # show SKILL.md content
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

const CLAW_HOME = join(homedir(), '.cli-claw');
const SKILLS_DIR = join(CLAW_HOME, 'skills');
const CODEX_SKILLS = join(homedir(), '.codex', 'skills');

// ─── ANSI ────────────────────────────────────
const c = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    cyan: '\x1b[36m',
};

// ─── Helpers ─────────────────────────────────
function listSkills() {
    mkdirSync(SKILLS_DIR, { recursive: true });
    return readdirSync(SKILLS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.'))
        .map(d => {
            const skillMd = join(SKILLS_DIR, d.name, 'SKILL.md');
            let desc = '';
            try {
                const content = readFileSync(skillMd, 'utf8');
                const match = content.match(/description:\s*(.+)/i);
                if (match) desc = match[1].trim();
            } catch { }
            return { name: d.name, desc };
        });
}

function installFromCodex(name) {
    const src = join(CODEX_SKILLS, name);
    const dst = join(SKILLS_DIR, name);
    if (existsSync(dst)) return { status: 'exists', path: dst };
    if (!existsSync(src)) return null;  // not in codex
    cpSync(src, dst, { recursive: true });
    return { status: 'installed', path: dst, source: 'codex' };
}

function installFromRef(name) {
    const REF_DIR = join(CLAW_HOME, 'skills_ref');
    const src = join(REF_DIR, name);
    const dst = join(SKILLS_DIR, name);
    if (existsSync(dst)) return { status: 'exists', path: dst };
    if (!existsSync(src) || !existsSync(join(src, 'SKILL.md'))) return null;
    cpSync(src, dst, { recursive: true });
    return { status: 'installed', path: dst, source: 'skills_ref' };
}

function installFromGithub(name) {
    // Try known repos: openai/codex
    const repos = [
        { owner: 'openai', repo: 'codex', path: `codex-cli/skills/${name}` },
    ];

    for (const { owner, repo, path } of repos) {
        try {
            const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
            const json = execSync(`curl -sL "${apiUrl}"`, { encoding: 'utf8', timeout: 15000 });
            const files = JSON.parse(json);
            if (!Array.isArray(files)) continue;

            const dst = join(SKILLS_DIR, name);
            mkdirSync(dst, { recursive: true });

            for (const f of files) {
                if (f.type === 'file' && f.download_url) {
                    const content = execSync(`curl -sL "${f.download_url}"`, { encoding: 'utf8', timeout: 10000 });
                    writeFileSync(join(dst, f.name), content);
                }
            }
            return { status: 'installed', path: dst, source: `github:${owner}/${repo}` };
        } catch { continue; }
    }
    return null;
}

// ─── CLI Routing ─────────────────────────────
const sub = process.argv[3];
const arg = process.argv[4];

switch (sub) {
    case 'install': {
        if (!arg) {
            console.log(`\n  Usage: cli-claw skill install <name>\n`);
            console.log(`  Examples:`);
            console.log(`    cli-claw skill install playwright`);
            console.log(`    cli-claw skill install doc\n`);
            process.exit(1);
        }

        const dst = join(SKILLS_DIR, arg);
        if (existsSync(dst)) {
            console.log(`\n  ${c.yellow}⏭️  "${arg}" already installed${c.reset}\n`);
            break;
        }

        console.log(`\n  ${c.bold}Installing skill: ${arg}${c.reset}\n`);

        // Try Codex first
        const codexResult = installFromCodex(arg);
        if (codexResult) {
            console.log(`  ${c.green}✅ Installed from ${codexResult.source}${c.reset}`);
            console.log(`  ${c.dim}${codexResult.path}${c.reset}\n`);
            break;
        }

        // Try skills_ref (local bundled skills)
        const refResult = installFromRef(arg);
        if (refResult) {
            console.log(`  ${c.green}✅ Installed from ${refResult.source}${c.reset}`);
            console.log(`  ${c.dim}${refResult.path}${c.reset}\n`);
            break;
        }

        // Try GitHub
        console.log(`  ${c.dim}Codex/Ref에 없음, GitHub 검색 중...${c.reset}`);
        const ghResult = installFromGithub(arg);
        if (ghResult) {
            console.log(`  ${c.green}✅ Installed from ${ghResult.source}${c.reset}`);
            console.log(`  ${c.dim}${ghResult.path}${c.reset}\n`);
        } else {
            console.log(`  ${c.red}❌ "${arg}" 스킬을 찾을 수 없습니다${c.reset}`);
            console.log(`  ${c.dim}직접 생성: mkdir -p ~/.cli-claw/skills/${arg} && touch ~/.cli-claw/skills/${arg}/SKILL.md${c.reset}\n`);
        }
        break;
    }

    case 'remove': {
        if (!arg) {
            console.log(`  Usage: cli-claw skill remove <name>`);
            process.exit(1);
        }
        const target = join(SKILLS_DIR, arg);
        if (!existsSync(target)) {
            console.log(`  ${c.red}❌ "${arg}" not found${c.reset}`);
            break;
        }
        rmSync(target, { recursive: true, force: true });
        console.log(`  ${c.green}✅ Removed: ${arg}${c.reset}`);
        break;
    }

    case 'info': {
        if (!arg) {
            console.log(`  Usage: cli-claw skill info <name>`);
            process.exit(1);
        }
        const skillMd = join(SKILLS_DIR, arg, 'SKILL.md');
        if (!existsSync(skillMd)) {
            console.log(`  ${c.red}❌ "${arg}" not found or no SKILL.md${c.reset}`);
            break;
        }
        console.log(`\n  ${c.bold}📋 ${arg}${c.reset}\n`);
        console.log(readFileSync(skillMd, 'utf8'));
        break;
    }

    case 'list':
    case undefined: {
        const skills = listSkills();
        console.log(`\n  ${c.bold}🧰 Installed Skills${c.reset} (${skills.length})\n`);
        if (!skills.length) {
            console.log(`  ${c.dim}(none)${c.reset}`);
        } else {
            for (const s of skills) {
                console.log(`  ${c.cyan}•${c.reset} ${c.bold}${s.name}${c.reset}${s.desc ? `  ${c.dim}${s.desc}${c.reset}` : ''}`);
            }
        }
        console.log(`\n  ${c.dim}cli-claw skill install <name>  — 스킬 설치${c.reset}`);
        console.log(`  ${c.dim}cli-claw skill info <name>     — 상세 보기${c.reset}`);
        console.log(`  ${c.dim}cli-claw skill remove <name>   — 삭제${c.reset}`);
        console.log(`  ${c.dim}cli-claw skill reset           — 초기화 (2×3 분류 재실행)${c.reset}\n`);
        break;
    }

    case 'reset': {
        const force = process.argv.includes('--force');
        if (!force) {
            const { createInterface } = await import('node:readline');
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            const answer = await new Promise(r => {
                rl.question(`\n  ${c.yellow}⚠️  스킬 디렉토리를 초기화합니다.${c.reset}\n  기존 active/ref 스킬이 삭제되고 2×3 분류가 재실행됩니다.\n  계속하시겠습니까? (y/N): `, r);
            });
            rl.close();
            if (answer.toLowerCase() !== 'y') {
                console.log('  취소됨.\n');
                break;
            }
        }

        console.log(`\n  ${c.bold}🔄 스킬 초기화 중...${c.reset}\n`);

        // 1. Clear active skills
        if (existsSync(SKILLS_DIR)) {
            rmSync(SKILLS_DIR, { recursive: true, force: true });
            console.log(`  ${c.dim}✓ cleared ${SKILLS_DIR}${c.reset}`);
        }
        mkdirSync(SKILLS_DIR, { recursive: true });

        // 2. Clear ref skills
        const REF_DIR = join(CLAW_HOME, 'skills_ref');
        if (existsSync(REF_DIR)) {
            rmSync(REF_DIR, { recursive: true, force: true });
            console.log(`  ${c.dim}✓ cleared ${REF_DIR}${c.reset}`);
        }
        mkdirSync(REF_DIR, { recursive: true });

        // 3. Re-run copyDefaultSkills (2×3 classification)
        try {
            const { copyDefaultSkills } = await import('../../lib/mcp-sync.js');
            const count = copyDefaultSkills();
            console.log(`\n  ${c.green}✅ 초기화 완료!${c.reset}`);

            // Count results
            const activeCount = readdirSync(SKILLS_DIR, { withFileTypes: true })
                .filter(d => d.isDirectory()).length;
            const refCount = readdirSync(REF_DIR, { withFileTypes: true })
                .filter(d => d.isDirectory()).length;
            console.log(`  ${c.cyan}⚡ Active: ${activeCount}개${c.reset}`);
            console.log(`  ${c.cyan}📦 Ref: ${refCount}개${c.reset}\n`);
        } catch (e) {
            console.error(`  ${c.red}❌ 초기화 실패: ${e.message}${c.reset}\n`);
        }
        break;
    }

    default:
        console.error(`  ${c.red}Unknown skill subcommand: ${sub}${c.reset}`);
        process.exit(1);
}
