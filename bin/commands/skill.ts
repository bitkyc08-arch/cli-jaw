/**
 * cli-jaw skill — Phase 12.1.6
 * Skill management: list, install, remove, info.
 *
 * Usage:
 *   cli-jaw skill                    # list installed skills
 *   cli-jaw skill install <name>     # install from Codex or GitHub
 *   cli-jaw skill remove <name>      # delete a skill
 *   cli-jaw skill info <name>        # show SKILL.md content
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { JAW_HOME, SKILLS_DIR } from '../../src/core/config.js';
import { isDiscoverableSkillDirName } from '../../lib/mcp/skills-utils.js';

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
        .filter(d => d.isDirectory() && isDiscoverableSkillDirName(d.name))
        .map(d => {
            const skillMd = join(SKILLS_DIR, d.name, 'SKILL.md');
            let desc = '';
            try {
                const content = readFileSync(skillMd, 'utf8');
                const match = content.match(/description:\s*(.+)/i);
                if (match) desc = match[1]!.trim();
            } catch { }
            return { name: d.name, desc };
        });
}

function installFromCodex(name: string) {
    const src = join(CODEX_SKILLS, name);
    const dst = join(SKILLS_DIR, name);
    if (existsSync(dst)) return { status: 'exists', path: dst };
    if (!existsSync(src)) return null;  // not in codex
    cpSync(src, dst, { recursive: true });
    return { status: 'installed', path: dst, source: 'codex' };
}

function installFromRef(name: string) {
    const REF_DIR = join(JAW_HOME, 'skills_ref');
    const src = join(REF_DIR, name);
    const dst = join(SKILLS_DIR, name);
    if (existsSync(dst)) return { status: 'exists', path: dst };
    if (!existsSync(src) || !existsSync(join(src, 'SKILL.md'))) return null;
    cpSync(src, dst, { recursive: true });
    return { status: 'installed', path: dst, source: 'skills_ref' };
}

function resolveSkillReadPath(name: string): { path: string; source: 'active' | 'skills_ref' } | null {
    const activePath = join(SKILLS_DIR, name, 'SKILL.md');
    if (existsSync(activePath)) return { path: activePath, source: 'active' };
    const refPath = join(JAW_HOME, 'skills_ref', name, 'SKILL.md');
    if (existsSync(refPath)) return { path: refPath, source: 'skills_ref' };
    return null;
}

function installFromGithub(name: string) {
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
        const force = process.argv.includes('--force');
        if (!arg || arg === '--force') {
            console.log(`\n  Usage: cli-jaw skill install <name>\n`);
            console.log(`  Options:`);
            console.log(`    --force    Overwrite existing skill\n`);
            process.exit(1);
        }

        const dst = join(SKILLS_DIR, arg);
        if (existsSync(dst) && !force) {
            console.log(`\n  ${c.yellow}⏭️  "${arg}" already installed (use --force to upgrade)${c.reset}\n`);
            break;
        }
        if (force && existsSync(dst)) {
            rmSync(dst, { recursive: true, force: true });
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
            console.log(`  ${c.dim}직접 생성: mkdir -p ~/.cli-jaw/skills/${arg} && touch ~/.cli-jaw/skills/${arg}/SKILL.md${c.reset}\n`);
        }
        break;
    }

    case 'remove': {
        if (!arg) {
            console.log(`  Usage: cli-jaw skill remove <name>`);
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

    case 'read':
    case 'info': {
        if (!arg) {
            console.log(`  Usage: cli-jaw skill info <name>`);
            process.exit(1);
        }
        const resolved = resolveSkillReadPath(arg);
        if (!resolved) {
            console.log(`  ${c.red}❌ "${arg}" not found or no SKILL.md${c.reset}`);
            break;
        }
        console.log(`\n  ${c.bold}📋 ${arg}${c.reset}`);
        if (resolved.source === 'skills_ref') {
            console.log(`  ${c.dim}source: skills_ref fallback${c.reset}`);
        }
        console.log('');
        console.log(readFileSync(resolved.path, 'utf8'));
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
        console.log(`\n  ${c.dim}cli-jaw skill install <name>  — 스킬 설치${c.reset}`);
        console.log(`  ${c.dim}cli-jaw skill info <name>     — 상세 보기${c.reset}`);
        console.log(`  ${c.dim}cli-jaw skill remove <name>   — 삭제${c.reset}`);
        console.log(`  ${c.dim}cli-jaw skill reset           — 초기화 (등록 스킬만 복원, 커스텀 보존)${c.reset}`);
        console.log(`  ${c.dim}cli-jaw skill reset hard      — 전체 삭제 후 재설치${c.reset}\n`);
        break;
    }

    case 'reset': {
        const isHard = process.argv.includes('hard') || process.argv.includes('--hard');
        const force = process.argv.includes('--force');
        if (!force) {
            const { createInterface } = await import('node:readline');
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            const msg = isHard
                ? `\n  ${c.yellow}⚠️  [HARD] 모든 스킬을 삭제하고 재설치합니다.${c.reset}\n  커스텀 스킬도 삭제됩니다. 계속? (y/N): `
                : `\n  ${c.yellow}⚠️  등록된 스킬을 초기값으로 복원합니다.${c.reset}\n  커스텀 스킬은 보존됩니다. 계속? (y/N): `;
            const answer = await new Promise(r => {
                rl.question(msg, r);
            });
            rl.close();
            if ((answer as string).toLowerCase() !== 'y') {
                console.log('  취소됨.\n');
                break;
            }
        }

        try {
            console.log(isHard
                ? `\n  ${c.bold}🔄 [HARD] 스킬 전체 초기화 중...${c.reset}\n`
                : `\n  ${c.bold}🔄 등록 스킬 복원 중...${c.reset}\n`);
            const { runSkillReset } = await import('../../lib/mcp-sync.js');
            const result = runSkillReset({
                mode: isHard ? 'hard' : 'soft',
                repairTargetDir: null,
            });
            console.log(`  ${c.dim}✓ ${result.restored}개 복원, ${result.added}개 추가${c.reset}`);
            if (typeof result.copied === 'number') {
                console.log(`  ${c.dim}✓ ${result.copied}개 기본 스킬 재분류${c.reset}`);
            }

            console.log(`\n  ${c.green}✅ 초기화 완료!${c.reset}`);
            const activeCount = readdirSync(SKILLS_DIR, { withFileTypes: true })
                .filter(d => d.isDirectory() && isDiscoverableSkillDirName(d.name)).length;
            const REF_DIR = join(JAW_HOME, 'skills_ref');
            const refCount = readdirSync(REF_DIR, { withFileTypes: true })
                .filter(d => d.isDirectory() && isDiscoverableSkillDirName(d.name)).length;
            console.log(`  ${c.cyan}⚡ Active: ${activeCount}개${c.reset}`);
            console.log(`  ${c.cyan}📦 Ref: ${refCount}개${c.reset}\n`);
        } catch (e) {
            console.error(`  ${c.red}❌ 초기화 실패: ${(e as Error).message}${c.reset}\n`);
        }
        break;
    }

    default:
        console.error(`  ${c.red}Unknown skill subcommand: ${sub}${c.reset}`);
        process.exit(1);
}
