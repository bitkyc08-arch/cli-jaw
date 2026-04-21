import fs from 'fs';
import os from 'os';
import { createHash } from 'crypto';
import { join } from 'path';
import { settings, JAW_HOME, PROMPTS_DIR, SKILLS_DIR, SKILLS_REF_DIR, loadHeartbeatFile, deriveCdpPort } from '../core/config.js';
import { getEmployees } from '../core/db.js';
import { memoryFlushCounter, flushCycleCount } from '../agent/spawn.js';
import { describeHeartbeatSchedule, normalizeHeartbeatSchedule } from '../memory/heartbeat-schedule.js';
import { buildTaskSnapshot, getMemoryStatus, loadProfileSummary } from '../memory/runtime.js';
import { buildMemoryInjection } from '../memory/injection.js';
import { loadAndRender, loadTemplate, renderTemplate, parseWorkerContexts, clearTemplateCache } from './template-loader.js';
import { findStaticEmployee } from '../core/employees.js';

const promptCache = new Map();

function getRepoBundledSkillPath(...parts: string[]): string {
    return join(process.cwd(), ...parts);
}

function findFirstExistingPath(paths: string[]): string | null {
    return paths.find(p => fs.existsSync(p)) || null;
}

// ─── Legacy A1 Source Hashes ─────────────────────────
// MD5 hashes of source templates (unrendered) for every historical pre-hash version.
// Used to identify known stock files during pre-hash migration.
const KNOWN_A1_SOURCE_HASHES = new Set([
    'b95f7d3d22cb79bd9be5bac577b68a9f', // 9d60b47 initial
    '9bbc1632e610cd3f764028ec6eb2c05d', // 1ea5aa6 heartbeat
    '70ff952b074ad95f6a6f1f40f59bde09', // c359545 memory
    '546d162f31b8a42008f815cbe928a434', // ecc958a sub-agent
    '2e2a3de20b9803bec3c7843ab2859ace', // 4b92441 browser
    'e0e1d2495f2859382b61bf0a816943ad', // 4f5e91a discord
]);

// ─── Migration Helpers ───────────────────────────────

function normalizeRenderedContent(content: string): string {
    return content
        .replaceAll(JAW_HOME, '{{JAW_HOME}}')
        .replaceAll(String(deriveCdpPort()), '{{CDP_PORT}}');
}

type LegacyA1MigrationAction = 'adopt-current-template' | 'preserve-custom-file';

export function resolveLegacyA1Migration(opts: {
    normalizedFileHash: string;
    currentSourceHash: string;
    knownSourceHashes: Set<string>;
}): LegacyA1MigrationAction {
    if (opts.normalizedFileHash === opts.currentSourceHash) return 'adopt-current-template';
    if (opts.knownSourceHashes.has(opts.normalizedFileHash)) return 'adopt-current-template';
    return 'preserve-custom-file';
}

// ─── Skill Loading ───────────────────────────────────

/** Read all active skills from JAW_HOME/skills/ */
export function loadActiveSkills() {
    try {
        if (!fs.existsSync(SKILLS_DIR)) return [];
        return fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
            .filter(d => d.isDirectory() && !d.name.startsWith('.'))
            .map(d => {
                const mdPath = join(SKILLS_DIR, d.name, 'SKILL.md');
                if (!fs.existsSync(mdPath)) return null;
                const content = fs.readFileSync(mdPath, 'utf8');
                const nameMatch = content.match(/^name:\s*(.+)/m);
                const descMatch = content.match(/^description:\s*"?(.+?)"?\s*$/m);
                return {
                    id: d.name,
                    name: nameMatch?.[1]?.trim() || d.name,
                    description: descMatch?.[1]?.trim() || '',
                    content,
                };
            })
            .filter(Boolean);
    } catch { return []; }
}

/** Read skills_ref registry.json */
export function loadSkillRegistry() {
    try {
        const regPath = join(SKILLS_REF_DIR, 'registry.json');
        if (!fs.existsSync(regPath)) return [];
        const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
        return Object.entries(reg.skills || {}).map(([id, s]: [string, any]) => ({ id, ...s }));
    } catch { return []; }
}

/** Get merged skill list (active + ref) for API */
export function getMergedSkills() {
    const active = loadActiveSkills();
    const activeIds = new Set(active.map(s => s!.id));
    const ref = loadSkillRegistry();
    const merged = [];

    // Active skills (from skills/)
    for (const s of active) {
        const refInfo = ref.find(r => r.id === s!.id);
        merged.push({
            id: s!.id,
            name: refInfo?.name || s!.name,
            name_ko: refInfo?.name_ko || undefined,
            name_en: refInfo?.name_en || undefined,
            emoji: refInfo?.emoji || '🔧',
            category: refInfo?.category || 'installed',
            description: refInfo?.description || s!.description,
            desc_ko: refInfo?.desc_ko || undefined,
            desc_en: refInfo?.desc_en || undefined,
            requires: refInfo?.requires || null,
            install: refInfo?.install || null,
            enabled: true,
            source: activeIds.has(s!.id) && ref.find(r => r.id === s!.id) ? 'both' : 'active',
        });
    }

    // Ref-only skills (not yet activated)
    for (const s of ref) {
        if (!activeIds.has(s.id)) {
            merged.push({
                ...s,
                enabled: false,
                source: 'ref',
            });
        }
    }
    return merged;
}

// ─── Prompt Templates ────────────────────────────────

/** Template variables shared across templates */
function getTemplateVars(): Record<string, string> {
    return { JAW_HOME, CDP_PORT: String(deriveCdpPort()) };
}

/** Render A1 system prompt from template */
function getA1Content(): string {
    return loadAndRender('a1-system.md', getTemplateVars());
}

/** A2 default content (no dynamic vars) */
function getA2Default(): string {
    return loadTemplate('a2-default.md');
}

/** Heartbeat default content (no dynamic vars) */
function getHeartbeatDefault(): string {
    return loadTemplate('heartbeat-default.md');
}

// ─── Paths ───────────────────────────────────────────

export const A1_PATH = join(PROMPTS_DIR, 'A-1.md');
export const A2_PATH = join(PROMPTS_DIR, 'A-2.md');
export const HEARTBEAT_PATH = join(PROMPTS_DIR, 'HEARTBEAT.md');

const DESKTOP_CONTROL_ANCHOR_OPEN = '<!-- anchor:desktop-control -->';
const DESKTOP_CONTROL_ANCHOR_CLOSE = '<!-- /anchor:desktop-control -->';

/**
 * Extract the Desktop/Browser Control anchor block from the rendered A1
 * template. Returns null when the template lacks the anchor pair (keeps
 * future refactors from silently producing empty appends).
 */
function extractDesktopControlAnchor(rendered: string): string | null {
    const start = rendered.indexOf(DESKTOP_CONTROL_ANCHOR_OPEN);
    const end = rendered.indexOf(DESKTOP_CONTROL_ANCHOR_CLOSE);
    if (start === -1 || end === -1 || end <= start) return null;
    return rendered.slice(start, end + DESKTOP_CONTROL_ANCHOR_CLOSE.length);
}

/**
 * Safely append the Desktop/Browser Control anchor block to a user-edited
 * A1 file when the anchor is missing. Returns true when an append was made.
 */
function ensureDesktopControlAnchor(fileContent: string, rendered: string): string | null {
    if (fileContent.includes(DESKTOP_CONTROL_ANCHOR_OPEN)) return null;
    const block = extractDesktopControlAnchor(rendered);
    if (!block) return null;
    const sep = fileContent.endsWith('\n') ? '\n' : '\n\n';
    return fileContent + sep + block + '\n';
}

// ─── Initialize prompt files ─────────────────────────

export function initPromptFiles() {
    const a1Content = getA1Content();
    const hashPath = A1_PATH + '.hash';
    const currentHash = createHash('md5').update(a1Content).digest('hex');

    if (!fs.existsSync(A1_PATH)) {
        // First install
        fs.writeFileSync(A1_PATH, a1Content);
        fs.writeFileSync(hashPath, currentHash);
    } else if (fs.existsSync(hashPath)) {
        const savedHash = fs.readFileSync(hashPath, 'utf8').trim();
        if (savedHash !== currentHash) {
            // Template changed — check if user edited the file
            const fileHash = createHash('md5').update(fs.readFileSync(A1_PATH, 'utf8')).digest('hex');
            if (fileHash === savedHash) {
                // User hasn't edited → safe to update
                fs.writeFileSync(A1_PATH, a1Content);
                fs.writeFileSync(hashPath, currentHash);
                console.log('[prompt] A-1.md updated to new version');
            } else {
                // User edited — preserve their changes, but advance hash baseline.
                // Safe-append new anchor blocks the user hasn't opted in to yet.
                const userText = fs.readFileSync(A1_PATH, 'utf8');
                const appended = ensureDesktopControlAnchor(userText, a1Content);
                if (appended) {
                    fs.writeFileSync(A1_PATH, appended);
                    console.log('[prompt] A-1.md: appended desktop-control anchor (user edits preserved)');
                } else {
                    console.log('[prompt] A-1.md has user edits — preserved');
                }
                fs.writeFileSync(hashPath, currentHash);
            }
        }
    } else {
        // Pre-hash migration: distinguish known stock files from customized ones
        const fileContent = fs.readFileSync(A1_PATH, 'utf8');
        const normalizedFileHash = createHash('md5')
            .update(normalizeRenderedContent(fileContent))
            .digest('hex');
        const currentSourceHash = createHash('md5')
            .update(loadTemplate('a1-system.md'))
            .digest('hex');
        const action = resolveLegacyA1Migration({
            normalizedFileHash,
            currentSourceHash,
            knownSourceHashes: KNOWN_A1_SOURCE_HASHES,
        });
        if (action === 'adopt-current-template') {
            fs.writeFileSync(A1_PATH, a1Content);
            fs.writeFileSync(hashPath, currentHash);
            console.log('[prompt] A-1.md migrated from known stock template');
        } else {
            fs.writeFileSync(hashPath, currentHash);
            console.log('[prompt] A-1.md preserved (customized legacy file)');
        }
    }

    if (!fs.existsSync(A2_PATH)) fs.writeFileSync(A2_PATH, getA2Default());
    if (!fs.existsSync(HEARTBEAT_PATH)) fs.writeFileSync(HEARTBEAT_PATH, getHeartbeatDefault());
}

// ─── Memory ──────────────────────────────────────────

export function getMemoryDir() {
    const wd = (settings.workingDir || os.homedir()).replace(/^~/, os.homedir());
    const hash = wd.replace(/\//g, '-');
    return join(os.homedir(), '.claude', 'projects', hash, 'memory');
}

export function loadRecentMemories() {
    try {
        const CHAR_BUDGET = 10000;
        const memDir = getMemoryDir();
        if (!fs.existsSync(memDir)) return '';
        const files = fs.readdirSync(memDir).filter(f => f.endsWith('.md')).sort().reverse();
        const entries = [];
        let charCount = 0;
        for (const f of files) {
            const sections = fs.readFileSync(join(memDir, f), 'utf8').split(/^## /m).filter(Boolean);
            for (const s of sections.reverse()) {
                const entry = s.trim();
                if (charCount + entry.length > CHAR_BUDGET) break;
                entries.push(entry);
                charCount += entry.length;
            }
            if (charCount >= CHAR_BUDGET) break;
        }
        if (entries.length) {
            console.log(`[memory] session memory loaded: ${entries.length} entries, ${charCount} chars`);
        }
        return entries.length
            ? '\n\n---\n## Recent Session Memories\n' + entries.map(e => '- ' + e.split('\n')[0]).join('\n')
            : '';
    } catch { return ''; }
}

// ─── System Prompt Generation ────────────────────────

function appendLegacyMemoryContext(prompt: string) {
    let next = prompt;
    try {
        const threshold = settings.memory?.flushEvery ?? 10;
        const injectInterval = Math.ceil(threshold / 2);
        const shouldInject = memoryFlushCounter % injectInterval === 0;
        if (shouldInject) {
            const memories = loadRecentMemories();
            if (memories) {
                next += memories;
                console.log(`[memory] injected (msg ${memoryFlushCounter}, every ${injectInterval})`);
            }
        } else {
            console.log(`[memory] skipped injection (msg ${memoryFlushCounter}/${threshold}, interval ${injectInterval})`);
        }
    } catch {
        const memories = loadRecentMemories();
        if (memories) next += memories;
    }

    try {
        const memPath = join(JAW_HOME, 'memory', 'MEMORY.md');
        if (fs.existsSync(memPath)) {
            const coreMem = fs.readFileSync(memPath, 'utf8').trim();
            if (coreMem && coreMem.length > 50) {
                const truncated = coreMem.length > 1500
                    ? coreMem.slice(0, 1500) + '\n...(use `cli-jaw memory read MEMORY.md` for full)'
                    : coreMem;
                next += '\n\n---\n## Core Memory\n' + truncated;
                console.log(`[memory] MEMORY.md loaded: ${truncated.length} chars`);
            }
        }
    } catch { /* memory not ready */ }

    return next;
}

function appendAdvancedMemoryContext(prompt: string, currentPrompt: string, providedSnapshot = '') {
    let next = prompt;
    const profile = loadProfileSummary(800);
    const snapshot = providedSnapshot || buildTaskSnapshot(currentPrompt, 2800);
    next += '\n\n---\n## Memory Runtime\n';
    next += '- indexed memory context is active\n';
    next += '- use task snapshot and profile context before assuming missing memory\n';
    if (profile) {
        next += '\n\n## Profile Context\n' + profile;
    }
    if (snapshot) {
        next += '\n\n' + snapshot;
    }
    return next;
}

export function shouldIncludeVisionClickHint(activeCli?: string | null): boolean {
    return activeCli === 'codex';
}

export function getSystemPrompt(opts: { currentPrompt?: string; forDisk?: boolean; memorySnapshot?: string; activeCli?: string } = {}) {
    // A-1: file takes priority (user-editable), rendered template fallback
    const a1 = fs.existsSync(A1_PATH) ? fs.readFileSync(A1_PATH, 'utf8') : getA1Content();
    const a2 = fs.existsSync(A2_PATH) ? fs.readFileSync(A2_PATH, 'utf8') : '';
    let prompt = `${a1}\n\n${a2}`;
    const currentPrompt = String(opts.currentPrompt || '').trim();
    const forDisk = opts.forDisk === true;
    const mem = getMemoryStatus();

    // Phase 15: Telegram guidance is now part of A1_CONTENT (hardcoded)
    // No dynamic injection needed — Bot-First policy with curl examples included

    if (!forDisk) {
        const injected = buildMemoryInjection({
            role: 'boss',
            currentPrompt,
            providedSnapshot: opts.memorySnapshot,
        });
        if (injected.mode === 'advanced') {
            prompt += '\n\n' + injected.text;
        } else {
            prompt = appendLegacyMemoryContext(prompt);
            prompt += '\n\n---\n## Memory Status\n';
            prompt += '- indexed memory is still initializing\n';
            prompt += '- temporary fallback memory context is active\n';
        }
    } else {
        prompt = appendLegacyMemoryContext(prompt);
    }

    try {
        const emps = getEmployees.all();
        if (emps.length > 0) {
            const list = emps.map(e =>
                `- "${(e as any).name}" (CLI: ${(e as any).cli}) — ${(e as any).role || 'general developer'}`
            ).join('\n');
            const example = (emps[0] as any).name;
            const vars = getTemplateVars();
            vars.EMPLOYEE_LIST = list;
            vars.EXAMPLE_AGENT = example;
            prompt += '\n\n---\n';
            prompt += renderTemplate(loadTemplate('orchestration.md'), vars);

            // PABCD orchestration skill (boss needs to know the workflow)
            const pabcdPath = join(SKILLS_DIR, 'dev-pabcd', 'SKILL.md');
            if (fs.existsSync(pabcdPath)) {
                prompt += `\n\n## PABCD Orchestration Guide\n${fs.readFileSync(pabcdPath, 'utf8')}`;
            }
        }
    } catch { /* DB not ready yet */ }

    try {
        const hbData = loadHeartbeatFile();
        if (hbData.jobs.length > 0) {
            const activeJobs = hbData.jobs.filter((j: any) => j.enabled);
            const jobList = hbData.jobs.map((job: any) => {
                const status = job.enabled ? '✅' : '⏸️';
                const schedule = normalizeHeartbeatSchedule(job.schedule);
                return `- ${status} "${job.name}" — ${describeHeartbeatSchedule(schedule)}: ${(job.prompt || '').slice(0, 50)}`;
            }).join('\n');
            const vars = getTemplateVars();
            vars.JOB_LIST = jobList;
            vars.ACTIVE_COUNT = String(activeJobs.length);
            vars.TOTAL_COUNT = String(hbData.jobs.length);
            prompt += '\n\n---\n' + renderTemplate(loadTemplate('heartbeat-jobs.md'), vars);
        }
    } catch { /* heartbeat.json not ready */ }

    try {
        const activeSkills = loadActiveSkills();
        const refSkills = loadSkillRegistry();
        const activeIds = new Set(activeSkills.map(s => s!.id));
        const availableRef = refSkills.filter(s => !activeIds.has(s.id));

        if (activeSkills.length > 0 || availableRef.length > 0) {
            prompt += '\n\n---\n## Skills System\n';

            const vars = getTemplateVars();
            vars.ACTIVE_SKILLS_COUNT = String(activeSkills.length);
            vars.ACTIVE_SKILLS_LIST = activeSkills.map(s => `- ${s!.name} (${s!.id})`).join('\n');
            vars.REF_SKILLS_COUNT = String(availableRef.length);
            vars.REF_SKILLS_LIST = availableRef.map(s => s.id).join(', ');

            // Only render sections that have content
            if (activeSkills.length > 0 && availableRef.length > 0) {
                prompt += renderTemplate(loadTemplate('skills.md'), vars);
            } else if (activeSkills.length > 0) {
                // Only active skills — render just that portion
                const tmpl = loadTemplate('skills.md');
                const activeSection = tmpl.split('### Available Skills')[0];
                const discoverySection = tmpl.split('### Skill Discovery')[1];
                prompt += renderTemplate(activeSection + '### Skill Discovery' + (discoverySection || ''), vars);
            } else {
                // Only ref skills
                const tmpl = loadTemplate('skills.md');
                const refSection = tmpl.substring(tmpl.indexOf('### Available Skills'));
                prompt += renderTemplate(refSection, vars);
            }
        }
    } catch { /* skills not ready */ }

    // ─── Vision-Click Hint (Codex only) ──────────────
    try {
        const activeCli = opts.activeCli || settings.cli;
        if (shouldIncludeVisionClickHint(activeCli)) {
            const visionSkillPath = join(SKILLS_DIR, 'vision-click', 'SKILL.md');
            if (fs.existsSync(visionSkillPath)) {
                prompt += '\n' + loadTemplate('vision-click.md');
            }
        }
    } catch { /* vision-click not ready */ }

    // ─── Delegation rules: jaw employees vs CLI sub-agents ───
    prompt += '\n\n---\n## Delegation Rules\n';
    prompt += '### CLI Sub-agents (Task/Agent tool)\n';
    prompt += 'You CAN use your CLI\'s Task/Agent tools for internal subtasks: research, parallel file reads, code analysis.\n';
    prompt += 'Subagents you spawn must NOT spawn further subagents (1-level only).\n';
    prompt += 'When spawning a subagent, include: "Do NOT use Agent, subagent, or delegation tools. Do all work directly."\n';
    prompt += '\n### jaw Employee Dispatch\n';
    prompt += 'To dispatch a jaw employee, run:\n';
    prompt += '```bash\ncli-jaw dispatch --agent "Name" --task "task description"\n```\n';
    prompt += 'Result is returned via stdout. Review and synthesize for the user.\n';
    prompt += '**⏰ Bash timeout**: always pass `timeout=600000` (10 min) to the Bash tool when running `cli-jaw dispatch`. Default 2-min limit will abort long-running employees and lose their results to pendingReplay.\n';
    prompt += '\n### ⛔ Do NOT confuse the two\n';
    prompt += '- Do NOT use CLI Task tool to "dispatch" jaw employees — use `cli-jaw dispatch`.\n';
    prompt += '- Do NOT assign simple research to jaw employees — use your CLI sub-agents instead.\n';

    return prompt;
}

// ─── Employee Prompt (orchestration-free) ────────────

export function getEmployeePrompt(emp: any) {
    const vars: Record<string, string> = {
        EMP_NAME: emp.name,
        EMP_ROLE: emp.role || 'general developer',
        ACTIVE_SKILLS_SECTION: '',
    };

    // Active Skills (dynamic loading)
    try {
        const activeSkills = loadActiveSkills();
        if (activeSkills.length > 0) {
            let section = `\n## Active Skills (${activeSkills.length})\n`;
            section += `Installed skills — automatically triggered by the CLI.\n`;
            for (const s of activeSkills) {
                section += `- ${s!.name} (${s!.id})\n`;
            }
            vars.ACTIVE_SKILLS_SECTION = section;
        }
    } catch { /* skills not ready */ }

    return renderTemplate(loadTemplate('employee.md'), vars);
}

// ─── Employee Prompt v2 (orchestration phase-aware) ──

export function getEmployeePromptV2(emp: any, role: any, currentPhase: number | string) {
    const phase = Number(currentPhase);
    const cacheKey = `${emp.id || emp.name}:${role}:${phase}:${settings.workingDir || '~'}`;
    if (promptCache.has(cacheKey)) return promptCache.get(cacheKey);

    let prompt = getEmployeePrompt(emp);

    // Static-employee system prompt patch (Control etc.) injected near the top
    // so role-specific guidance downstream can still override style/tone.
    const staticSpec = findStaticEmployee(emp?.name || '');
    if (staticSpec?.systemPromptPatchFile) {
        try {
            const patch = loadTemplate(staticSpec.systemPromptPatchFile);
            if (patch) prompt += `\n\n${patch}`;
        } catch (e) {
            console.warn(`[prompt] ${staticSpec.name} system patch load failed:`, (e as Error).message);
        }
    }

    // Static-employee declared skills are injected INLINE so the employee never
    // needs to read skill files from disk. Previously `skills: [...]` was metadata
    // only — employees tried `sed`/`cat` on absolute paths (often wrong), wasting
    // a turn and sometimes failing entirely. The skill content now lives in the
    // system prompt; reference files (`reference/*.md`) stay on disk for deep
    // lookups the employee can do with `cli-jaw skill read <name> <ref>`.
    if (staticSpec?.skills?.length) {
        for (const skillName of staticSpec.skills) {
            const skillPath = findFirstExistingPath([
                join(SKILLS_DIR, skillName, 'SKILL.md'),
                join(SKILLS_REF_DIR, skillName, 'SKILL.md'),
                getRepoBundledSkillPath('skills', skillName, 'SKILL.md'),
                getRepoBundledSkillPath('skills_ref', skillName, 'SKILL.md'),
            ]);
            if (skillPath && fs.existsSync(skillPath)) {
                prompt += `\n\n## Skill: ${skillName} (inlined — do NOT read from disk)\n${fs.readFileSync(skillPath, 'utf8')}`;
            } else {
                console.warn(`[prompt] ${staticSpec.name}: skill '${skillName}' not found on disk — check SKILLS_DIR/SKILLS_REF_DIR`);
            }
        }
    }

    // ─── 1. Common dev skill (always injected)
    const devCommonPath = findFirstExistingPath([
        join(SKILLS_DIR, 'dev', 'SKILL.md'),
        getRepoBundledSkillPath('skills', 'dev', 'SKILL.md'),
    ]);
    if (devCommonPath) {
        prompt += `\n\n## Development Guide (Common)\n${fs.readFileSync(devCommonPath, 'utf8')}`;
    }

    // ─── 1b. Scaffolding guide (always injected)
    const scaffoldingPath = findFirstExistingPath([
        join(SKILLS_DIR, 'dev-scaffolding', 'SKILL.md'),
        getRepoBundledSkillPath('skills', 'dev-scaffolding', 'SKILL.md'),
    ]);
    if (scaffoldingPath) {
        prompt += `\n\n## Project Scaffolding Guide\n${fs.readFileSync(scaffoldingPath, 'utf8')}`;
    }

    // ─── 2. Role-based dev skill injection
    const ROLE_SKILL_MAP = {
        frontend: findFirstExistingPath([
            join(SKILLS_DIR, 'dev-frontend', 'SKILL.md'),
            getRepoBundledSkillPath('skills', 'dev-frontend', 'SKILL.md'),
        ]),
        backend: findFirstExistingPath([
            join(SKILLS_DIR, 'dev-backend', 'SKILL.md'),
            getRepoBundledSkillPath('skills', 'dev-backend', 'SKILL.md'),
        ]),
        data: findFirstExistingPath([
            join(SKILLS_DIR, 'dev-data', 'SKILL.md'),
            getRepoBundledSkillPath('skills', 'dev-data', 'SKILL.md'),
        ]),
        docs: findFirstExistingPath([
            join(SKILLS_DIR, 'documentation', 'SKILL.md'),
            getRepoBundledSkillPath('skills', 'documentation', 'SKILL.md'),
        ]),
        custom: null,
    };

    const skillPath = (ROLE_SKILL_MAP as Record<string, any>)[role];
    if (skillPath && fs.existsSync(skillPath)) {
        prompt += `\n\n## Development Guide (${role})\n${fs.readFileSync(skillPath, 'utf8')}`;
    }

    // ─── 3a. Plan audit phase(2) → inject dev-code-reviewer
    if (phase === 2) {
        const reviewerPath = findFirstExistingPath([
            join(SKILLS_DIR, 'dev-code-reviewer', 'SKILL.md'),
            join(SKILLS_REF_DIR, 'dev-code-reviewer', 'SKILL.md'),
            getRepoBundledSkillPath('skills', 'dev-code-reviewer', 'SKILL.md'),
            getRepoBundledSkillPath('skills_ref', 'dev-code-reviewer', 'SKILL.md'),
        ]);
        if (reviewerPath) {
            prompt += `\n\n## Code Review Guide (Phase 2 — Strict Audit)\n${fs.readFileSync(reviewerPath, 'utf8')}`;
        }
    }

    // ─── 3b. Debug/check phase(4) → inject dev-testing
    if (phase === 4) {
        const testingPath = findFirstExistingPath([
            join(SKILLS_DIR, 'dev-testing', 'SKILL.md'),
            join(SKILLS_REF_DIR, 'dev-testing', 'SKILL.md'),
            getRepoBundledSkillPath('skills', 'dev-testing', 'SKILL.md'),
            getRepoBundledSkillPath('skills_ref', 'dev-testing', 'SKILL.md'),
        ]);
        if (testingPath) {
            prompt += `\n\n## Testing Guide (Phase 4)\n${fs.readFileSync(testingPath, 'utf8')}`;
        }
    }

    // ─── 4. Employee context (PABCD-aware)
    const workerContexts = parseWorkerContexts();
    const ctx = workerContexts[phase] || workerContexts[3];
    prompt += `\n\n## Employee Role\n${ctx}`;
    prompt += `\n\n## Execution Rules`;
    prompt += `\n- Read the worklog first to understand context`;
    prompt += `\n- Do not touch files outside your assigned scope`;
    prompt += `\n- Focus only on your assigned area`;
    prompt += `\n- Report results clearly with specific file paths and line numbers`;

    prompt += `\n\n## Delegation Rules`;
    prompt += `\n- Execute the assigned task directly in this employee session.`;
    prompt += `\n- You CAN use CLI sub-agents (Task/Agent tool) for parallel work: research, file reads, code analysis. This is encouraged.`;
    prompt += `\nWhen spawning a sub-agent, include: "Do NOT use Agent, subagent, or delegation tools. Do all work directly."`;
    prompt += `\n- ⛔ Do NOT run \`cli-jaw dispatch\` or any equivalent delegation command from this session.`;
    prompt += `\n- ⛔ Do NOT output jaw dispatch JSON or subtask JSON.`;
    prompt += `\n- ⛔ Do NOT describe Boss/employee orchestration structure in your answer.`;

    promptCache.set(cacheKey, prompt);
    return prompt;
}

export function clearPromptCache() { promptCache.clear(); }

let _lastPromptHash = '';

export function regenerateB() {
    clearTemplateCache();
    clearPromptCache();
    const fullPrompt = getSystemPrompt({ forDisk: true });

    // Skip file write if content unchanged — preserves mtime so CLI prompt
    // caching (Claude --append, Codex resume) is not invalidated each turn.
    const hash = createHash('sha256').update(fullPrompt).digest('hex');
    if (hash === _lastPromptHash) return;
    _lastPromptHash = hash;

    fs.writeFileSync(join(PROMPTS_DIR, 'B.md'), fullPrompt);

    // Generate {workDir}/AGENTS.md — read by Codex, Copilot, and OpenCode
    try {
        const wd = settings.workingDir || os.homedir();
        fs.writeFileSync(join(wd, 'AGENTS.md'), fullPrompt);
        console.log(`[prompt] AGENTS.md generated at ${wd}`);
    } catch (e: unknown) {
        console.error(`[prompt] AGENTS.md generation failed:`, (e as Error).message);
    }
}
