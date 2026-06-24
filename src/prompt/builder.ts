import fs from 'fs';
import os from 'os';
import { createHash } from 'crypto';
import { join } from 'path';
import { settings, JAW_HOME, PROMPTS_DIR, SKILLS_DIR, SKILLS_REF_DIR, loadHeartbeatFile, deriveCdpPort } from '../core/config.js';
import { expandHomePath } from '../core/path-expand.js';
import { stripUndefined } from '../core/strip-undefined.js';
import { getEmployees } from '../core/db.js';
import { memoryFlushCounter } from '../agent/spawn.js';
import { describeHeartbeatSchedule, normalizeHeartbeatSchedule } from '../memory/heartbeat-schedule.js';
import { buildTaskSnapshot, loadProfileSummary } from '../memory/runtime.js';
import { buildMemoryInjection } from '../memory/injection.js';
import { loadAndRender, loadTemplate, renderTemplate, parseWorkerContexts, clearTemplateCache } from './template-loader.js';
import { findStaticEmployee } from '../core/employees.js';
import { isDiscoverableSkillDirName } from '../../lib/mcp/skills-utils.js';
import { getEmployeeMcpToolSummary } from '../agent/mcp-passthrough.js';
import { buildInjectionBlock as buildRuntimeContextBlock } from './runtime-context.js';

const promptCache = new Map();

function getRepoBundledSkillPath(...parts: string[]): string {
    return join(process.cwd(), ...parts);
}

function findFirstExistingPath(paths: string[]): string | null {
    return paths.find(p => fs.existsSync(p)) || null;
}

function findSkillPath(skillName: string): string | null {
    return findFirstExistingPath([
        join(SKILLS_DIR, skillName, 'SKILL.md'),
        join(SKILLS_REF_DIR, skillName, 'SKILL.md'),
        getRepoBundledSkillPath('skills', skillName, 'SKILL.md'),
        getRepoBundledSkillPath('skills_ref', skillName, 'SKILL.md'),
    ]);
}

function normalizeSkillDescription(description: unknown): string {
    return String(description || '')
        .trim()
        .replace(/^["']|["']$/g, '')
        .replace(/\s+/g, ' ');
}

function normalizeSkillMetadataList(value: unknown): string[] {
    if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
    const raw = String(value || '').trim();
    if (!raw) return [];
    const unwrapped = raw.replace(/^\[/, '').replace(/\]$/, '');
    return unwrapped.split(',').map(v => v.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

function parseTopLevelSkillMetadataList(content: string, field: string): string[] {
    const inlineMatch = content.match(new RegExp(`^${field}:[ \\t]*(.+)$`, 'm'));
    if (inlineMatch?.[1]) return normalizeSkillMetadataList(inlineMatch[1]);
    const yamlMatch = content.match(new RegExp(`^${field}:[ \\t]*\\n((?:[ \\t]+-[ \\t]*.+\\n?)+)`, 'm'));
    if (yamlMatch?.[1]) {
        return yamlMatch[1]
            .split('\n')
            .map(line => line.replace(/^\s+-\s*/, '').replace(/^["']|["']$/g, '').trim())
            .filter(Boolean);
    }
    return [];
}

function parseSkillMetadataObject(content: string): Record<string, unknown> {
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
    const source = frontmatter?.[1] || content;
    const metadataMatch = source.match(/^metadata:\s*\n([\s\S]*)$/m);
    if (!metadataMatch?.[1]) return {};
    let raw = metadataMatch[1];
    const nextTopLevelKey = raw.search(/\n[A-Za-z0-9_-]+:\s*/);
    if (nextTopLevelKey >= 0) raw = raw.slice(0, nextTopLevelKey);
    try {
        const parsed = JSON.parse(raw.trim());
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
        return {};
    }
}

function parseSkillMetadataList(content: string, field: string): string[] {
    const topLevel = parseTopLevelSkillMetadataList(content, field);
    const metadata = parseSkillMetadataObject(content);
    const nested = normalizeSkillMetadataList(metadata[field]);
    return [...new Set([...topLevel, ...nested])];
}

function formatSkillRoutingMetadata(skill: { keywords?: unknown; triggers?: unknown }): string {
    const keywords = normalizeSkillMetadataList(skill.keywords);
    const triggers = normalizeSkillMetadataList(skill.triggers);
    const parts = [];
    if (keywords.length) parts.push(`keywords: ${keywords.join(', ')}`);
    if (triggers.length) parts.push(`triggers: ${triggers.join(', ')}`);
    return parts.length ? ` [${parts.join('; ')}]` : '';
}

function readSkillMetadata(skillName: string, skillPath: string | null): { name: string; description: string; keywords: string[]; triggers: string[]; capabilities: string[]; references: string[] } {
    if (!skillPath || !fs.existsSync(skillPath)) return { name: skillName, description: '', keywords: [], triggers: [], capabilities: [], references: [] };
    try {
        const content = fs.readFileSync(skillPath, 'utf8');
        const nameMatch = content.match(/^name:\s*(.+)/m);
        const descMatch = content.match(/^description:\s*"?(.+?)"?\s*$/m);
        return {
            name: nameMatch?.[1]?.trim() || skillName,
            description: normalizeSkillDescription(descMatch?.[1]),
            keywords: parseSkillMetadataList(content, 'keywords'),
            triggers: parseSkillMetadataList(content, 'triggers'),
            capabilities: parseSkillMetadataList(content, 'capabilities'),
            references: parseSkillMetadataList(content, 'references'),
        };
    } catch {
        return { name: skillName, description: '', keywords: [], triggers: [], capabilities: [], references: [] };
    }
}

export function formatSkillListItem(skill: { id: string; name?: string; description?: string; keywords?: unknown; triggers?: unknown }): string {
    const name = String(skill.name || skill.id).trim();
    const label = name && name !== skill.id ? `${name} (${skill.id})` : skill.id;
    const description = normalizeSkillDescription(skill.description);
    const routing = formatSkillRoutingMetadata(skill);
    return description ? `- ${label} — ${description}${routing}` : `- ${label}${routing}`;
}

function formatSkillPath(skillName: string, skillPath: string | null): string {
    if (!skillPath) return `${skillName}: unavailable`;
    const meta = readSkillMetadata(skillName, skillPath);
    const label = meta.name && meta.name !== skillName ? `${meta.name} (${skillName})` : skillName;
    return meta.description
        ? `${label}: ${skillPath} — ${meta.description}${formatSkillRoutingMetadata(meta)}`
        : `${label}: ${skillPath}${formatSkillRoutingMetadata(meta)}`;
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
            .filter(d => d.isDirectory() && isDiscoverableSkillDirName(d.name))
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
                    keywords: parseSkillMetadataList(content, 'keywords'),
                    triggers: parseSkillMetadataList(content, 'triggers'),
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
    // DIAGRAM_CAPABILITIES/REFERENCES vars removed (#prompt-cache): the A-1
    // diagram section now defers that detail to the skill's MUST-READ body.
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
const DASHBOARD_CONNECTOR_ANCHOR_OPEN = '<!-- anchor:dashboard-connector-intent -->';
const DASHBOARD_CONNECTOR_ANCHOR_CLOSE = '<!-- /anchor:dashboard-connector-intent -->';
const SESSION_POLL_ANCHOR_OPEN = '<!-- anchor:session-poll -->';
const SESSION_POLL_ANCHOR_CLOSE = '<!-- /anchor:session-poll -->';

function extractAnchorBlock(rendered: string, open: string, close: string): string | null {
    const start = rendered.indexOf(open);
    const end = rendered.indexOf(close);
    if (start === -1 || end === -1 || end <= start) return null;
    return rendered.slice(start, end + close.length);
}

function appendAnchorIfMissing(
    fileContent: string,
    rendered: string,
    open: string,
    close: string,
): string | null {
    if (fileContent.includes(open)) return null;
    const block = extractAnchorBlock(rendered, open, close);
    if (!block) return null;
    const sep = fileContent.endsWith('\n') ? '\n' : '\n\n';
    return fileContent + sep + block + '\n';
}

/**
 * Safely append the Desktop/Browser Control anchor block to a user-edited
 * A1 file when the anchor is missing. Returns true when an append was made.
 */
function ensureDesktopControlAnchor(fileContent: string, rendered: string): string | null {
    return appendAnchorIfMissing(
        fileContent,
        rendered,
        DESKTOP_CONTROL_ANCHOR_OPEN,
        DESKTOP_CONTROL_ANCHOR_CLOSE,
    );
}

function ensureDashboardConnectorAnchor(fileContent: string, rendered: string): string | null {
    return appendAnchorIfMissing(
        fileContent,
        rendered,
        DASHBOARD_CONNECTOR_ANCHOR_OPEN,
        DASHBOARD_CONNECTOR_ANCHOR_CLOSE,
    );
}

function ensureSessionPollAnchor(fileContent: string, rendered: string): string | null {
    return appendAnchorIfMissing(
        fileContent,
        rendered,
        SESSION_POLL_ANCHOR_OPEN,
        SESSION_POLL_ANCHOR_CLOSE,
    );
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
                let userText = fs.readFileSync(A1_PATH, 'utf8');
                const appendedDesktop = ensureDesktopControlAnchor(userText, a1Content);
                if (appendedDesktop) {
                    userText = appendedDesktop;
                    console.log('[prompt] A-1.md: appended desktop-control anchor (user edits preserved)');
                }
                const appendedConnector = ensureDashboardConnectorAnchor(userText, a1Content);
                if (appendedConnector) {
                    userText = appendedConnector;
                    console.log('[prompt] A-1.md: appended dashboard-connector-intent anchor (user edits preserved)');
                }
                const appendedSessionPoll = ensureSessionPollAnchor(userText, a1Content);
                if (appendedSessionPoll) {
                    userText = appendedSessionPoll;
                    console.log('[prompt] A-1.md: appended session-poll anchor (user edits preserved)');
                }
                if (appendedDesktop || appendedConnector || appendedSessionPoll) {
                    fs.writeFileSync(A1_PATH, userText);
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
    const wd = expandHomePath(settings["workingDir"] || os.homedir(), os.homedir());
    const hash = wd.replace(/[\\/]/g, '-');
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
        const threshold = settings["memory"]?.flushEvery ?? 10;
        const injectInterval = Math.ceil(threshold / 2);
        // Phase 53-A: Always inject memory in the first 3 turns of a session
        // so short conversations never miss context.
        const shouldInject = memoryFlushCounter < 3 || memoryFlushCounter % injectInterval === 0;
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

export function shouldIncludeVisionClickHint(activeCli?: string | null): boolean {
    return activeCli === 'codex';
}

export function getBoundedLocalSearchContract(): string {
    return [
        '## Bounded Local Search Contract',
        '- Native local search tools such as `grep_search`, Grep, Glob, or broad file listing must start from one known file or a narrow task-specific directory.',
        '- Never run local search from `/`, a home directory, the whole runtime directory, dependency trees, caches, logs, backups, generated trees, or database files such as `*.db`.',
        '- If a shell search is needed, prefer a bounded form such as `timeout 20s rg --glob \'!*.db\' --glob \'!*.log\' <query> <narrow-path>` and cap output.',
        '- If a search times out, do not widen the search. Mark the item unresolved, ask for a narrower path when needed, or stop with a partial result.',
        '- Use exact file checks (`test -e`, `test -s`, or a direct file read) when checking a known path; do not discover known files through repository-wide search.',
    ].join('\n');
}

export function getSystemPrompt(opts: { currentPrompt?: string; forDisk?: boolean; memorySnapshot?: string; activeCli?: string } = {}) {
    // A-1: file takes priority (user-editable), rendered template fallback
    const a1 = fs.existsSync(A1_PATH) ? fs.readFileSync(A1_PATH, 'utf8') : getA1Content();
    const a2 = fs.existsSync(A2_PATH) ? fs.readFileSync(A2_PATH, 'utf8') : '';
    let prompt = `${a1}\n\n${a2}`;
    // Project root is now injected per-message in spawn.ts (user prompt wrapper)
    const currentPrompt = String(opts.currentPrompt || '').trim();
    const forDisk = opts.forDisk === true;

    // Phase 15: Telegram guidance is now part of A1_CONTENT (hardcoded)
    // No dynamic injection needed — Bot-First policy with curl examples included

    if (!forDisk) {
        const injected = buildMemoryInjection(stripUndefined({
            role: 'boss',
            currentPrompt,
            providedSnapshot: opts.memorySnapshot,
        }));
        if (injected.mode === 'advanced') {
            prompt += '\n\n' + injected.text;
        } else {
            prompt = appendLegacyMemoryContext(prompt);
            prompt += '\n\n---\n## Memory Status\n';
            prompt += '- indexed memory is still initializing\n';
            prompt += '- temporary fallback memory context is active\n';
        }
    } else {
        // Phase 54-B: forDisk (AGENTS.md) — include a minimal memory block
        // so Codex/OpenCode sessions have soul, profile, and snapshot context.
        prompt = appendLegacyMemoryContext(prompt);
        try {
            const profile = loadProfileSummary(600);
            const snapshot = buildTaskSnapshot('current session context', 1500);
            if (profile || snapshot) {
                prompt += '\n\n---\n## Core Memory\n';
                if (profile) prompt += profile + '\n';
                if (snapshot) prompt += '\n' + snapshot;
            }
        } catch { /* memory not ready for disk generation */ }
    }

    try {
        const emps = getEmployees.all();
        if (emps.length > 0) {
            const list = emps.map(e => {
                const r = e as { name: string; cli: string; role?: string };
                return `- "${r.name}" (CLI: ${r.cli}) — ${r.role || 'general developer'}`;
            }).join('\n');
            const example = (emps[0] as { name: string }).name;
            const vars = getTemplateVars();
            vars["EMPLOYEE_LIST"] = list;
            vars["EXAMPLE_AGENT"] = example;
            prompt += '\n\n---\n';
            prompt += renderTemplate(loadTemplate('orchestration.md'), vars);

            // PABCD orchestration: command summary stays inline; the full skill
            // body is a MUST-READ path contract (#prompt-cache — was 9.4KB inline).
            const pabcdPath = join(SKILLS_DIR, 'dev-pabcd', 'SKILL.md');
            if (fs.existsSync(pabcdPath)) {
                prompt += `\n\n## PABCD Orchestration Guide
PABCD is the structured 5-phase development workflow: I(Interview) → P(Plan) → A(Plan Audit) → B(Build) → C(Check) → D(Done). Large/"loop" work runs as MULTIPLE passes — one full P→A→B→C→D per work-phase (a work-phase is an outcome slice, not a PABCD letter).
- Transitions are shell commands only: \`cli-jaw orchestrate I|P|A|B|C|D\` (forward-only; \`I\` reachable from any state, context preserved; \`reset\` → IDLE).
- Forward transitions (P→A→B→C→D) require an EVIDENCE attestation, not narration ("현재는 B입니다" does nothing): \`cli-jaw orchestrate B --attest '{"from":"A","to":"B","did":"<what you did>"}'\` (C→D also needs \`checkOutput\`+\`exitCode\`). The state machine only moves on the command.
- Gates: P/A/B end with ⛔ STOP — present results and WAIT for user approval before advancing (goal mode self-advances). In goal mode, after D the agent re-enters P (D→IDLE→P) for the next work-phase until the objective is met; do each phase's real work, never rubber-stamp to advance.
- A audits the PLAN via a read-only employee dispatch; B: YOU write all code, employees verify (\`--mutable\` is the only write exception); C runs mechanical checks (tsc/tests) then D summarizes.
- Devlog plan docs use decade numbering (00-09 research, 10-19 phase 1, ...). A loop/multi-pass task pre-plans the full slice map and scaffolds per-phase docs up front, and may open with a design-only PABCD pass.
⛔ BEFORE running any PABCD phase, you MUST read the full workflow guide once per session: ${pabcdPath}
It defines phase contracts, dispatch pitfalls (delegation trap, context drift, phase skip), worklog/plan injection rules, and repository-root contracts that are NOT repeated here.`;
            }
        }
    } catch { /* DB not ready yet */ }

    // Boss Dev Work Classification contract (92_runtime_skill_routing_plan).
    // Compact, unconditional — renders identically with or without employees.
    prompt += '\n\n---\n## Dev Work Classification (contract)\n';
    prompt += 'Before coding, classify work C0-C5 (C0 trivial text, C1 single-file local, C2 ordinary product slice — endpoint/form/screen, C3 cross-domain — multiple modules/public API, C4 high-risk — auth/payments/security/data deletion/migration/release/permissions, C5 research/ambiguous). When signals match two classes, the higher class wins.\n';
    prompt += 'Use direct mode for C0-C1, a compact plan for C2, compact/full PABCD for C3 when persistence, public contract, or architecture risk requires it, full PABCD for C4, research/interview for C5.\n';
    prompt += 'Dispatch employees only for independent specialist work, plan/build verification, or high-risk review. Optional dispatch `task_tags` (e.g. tdd, threat_model, migration_backfill, frontend_ui) add specialist guidance without changing the employee role.\n';
    prompt += 'C4-promotion triggers (DEV-ESCALATE-01: security, data deletion/migration, destructive ops, public contract change, release surface, permission model, new dependency/framework) override any fast path and promote the affected part to C4-level care. Ask the user before destructive actions, new dependency/framework, public API/schema change, irreversible migration, permission model change, or unresolved business ambiguity.\n';
    prompt += 'Verify with the narrowest command that proves the claim; run affected-suite gates for C3 and full relevant gates for C4 or release-sensitive work.\n';

    try {
        const hbData = loadHeartbeatFile();
        if (hbData.jobs.length > 0) {
            const activeJobs = hbData.jobs.filter((j) => j.enabled);
            const jobList = hbData.jobs.map((job) => {
                const status = job.enabled ? '✅' : '⏸️';
                const schedule = normalizeHeartbeatSchedule(job.schedule);
                return `- ${status} "${job.name}" — ${describeHeartbeatSchedule(schedule)}: ${(job.prompt || '').slice(0, 50)}`;
            }).join('\n');
            const vars = getTemplateVars();
            vars["JOB_LIST"] = jobList;
            vars["ACTIVE_COUNT"] = String(activeJobs.length);
            vars["TOTAL_COUNT"] = String(hbData.jobs.length);
            prompt += '\n\n---\n' + renderTemplate(loadTemplate('heartbeat-jobs.md'), vars);
        }
    } catch (error) {
        prompt += '\n\n---\n## Heartbeat Jobs\n';
        prompt += `Heartbeat file failed to load: ${(error as Error).message}\n`;
    }

    try {
        const activeSkills = loadActiveSkills();
        const refSkills = loadSkillRegistry();
        const activeIds = new Set(activeSkills.map(s => s!.id));
        const availableRef = refSkills.filter(s => !activeIds.has(s.id));

        if (activeSkills.length > 0 || availableRef.length > 0) {
            prompt += '\n\n---\n## Skills System\n';

            const vars = getTemplateVars();
            vars["ACTIVE_SKILLS_COUNT"] = String(activeSkills.length);
            vars["ACTIVE_SKILLS_LIST"] = activeSkills.map(s => formatSkillListItem({
                id: s!.id,
                name: s!.name,
                description: s!.description,
                keywords: s!.keywords,
                triggers: s!.triggers,
            })).join('\n');
            vars["REF_SKILLS_COUNT"] = String(availableRef.length);

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
                const matchingSection = tmpl.split('### Active Skills')[0];
                const refSection = tmpl.substring(tmpl.indexOf('### Available Skills'));
                prompt += renderTemplate(matchingSection + refSection, vars);
            }
        }
    } catch { /* skills not ready */ }

    // ─── Vision-Click Hint (Codex only) ──────────────
    try {
        const activeCli = opts.activeCli || settings["cli"];
        if (shouldIncludeVisionClickHint(activeCli)) {
            const visionSkillPath = join(SKILLS_DIR, 'vision-click', 'SKILL.md');
            if (fs.existsSync(visionSkillPath)) {
                prompt += '\n' + loadTemplate('vision-click.md');
            }
        }
    } catch { /* vision-click not ready */ }

    // ─── Runtime context (short-lived user intent notes) ───
    if (!forDisk) {
        try {
            const block = buildRuntimeContextBlock();
            if (block) prompt += '\n\n---\n' + block;
        } catch { /* runtime-context not ready */ }
    }

    prompt += '\n\n---\n' + getBoundedLocalSearchContract();

    // ─── Delegation rules: jaw employees vs CLI sub-agents ───
    // Always-injected guard block (survives user-edited A-1.md overrides).
    // Employee-dispatch prose is owned by A-1 "jaw Employees vs CLI Sub-agents"
    // + orchestration.md; only the prohibition + timeout directive stay here.
    prompt += '\n\n---\n## Delegation Rules\n';
    prompt += '### CLI Sub-agents (Task/Agent tool)\n';
    prompt += 'You CAN use your CLI\'s Task/Agent tools for internal subtasks: research, parallel file reads, code analysis.\n';
    prompt += 'Subagents you spawn must NOT spawn further subagents (1-level only).\n';
    prompt += 'When spawning a subagent, include: "Do NOT use Agent, subagent, or delegation tools. Do all work directly."\n';
    prompt += '\n### jaw Employee Dispatch\n';
    prompt += 'Dispatch via `cli-jaw dispatch --agent "Name" --task "..."` — result returns via stdout. **⏰ Always pass `timeout=600000` (10 min) to the Bash tool**; the 2-min default aborts long employees and strands results in pendingReplay.\n';
    prompt += '\n### ⛔ Do NOT confuse the two\n';
    prompt += 'CLI Task tool ≠ jaw employee dispatch. Simple research → CLI sub-agents, never employees (full rules: "jaw Employees vs CLI Sub-agents" section).\n';

    return prompt;
}

// ─── Employee Prompt (orchestration-free) ────────────

export function getEmployeePrompt(emp: { name: string; role?: string; id?: string | number }) {
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
            section += `Installed skills — automatically triggered by the CLI. Use each description to decide whether to read its SKILL.md.\n`;
            section += `Read active skills from ${SKILLS_DIR}/<skill-id>/SKILL.md.\n`;
            section += `Match by intent, not exact words: compare the request, files, domain nouns, output, and task verbs against visible skill names, descriptions, and any listed metadata, keywords, or triggers.\n`;
            section += `When uncertain, inspect the best candidate: if metadata suggests a plausible match, read that SKILL.md once before deciding it does not apply.\n`;
            section += `Search intent override: for "검색", "검색해", "찾아봐", "알아봐", "look up", or "search" targeting external/current/docs/library information, inspect the active search skill before local Grep/Glob.\n`;
            for (const s of activeSkills) {
                section += `${formatSkillListItem({
                    id: s!.id,
                    name: s!.name,
                    description: s!.description,
                    keywords: s!.keywords,
                    triggers: s!.triggers,
                })}\n`;
            }
            vars["ACTIVE_SKILLS_SECTION"] = section;
        }
    } catch { /* skills not ready */ }

    return renderTemplate(loadTemplate('employee.md'), vars);
}

// ─── Employee Prompt v2 (orchestration phase-aware) ──

// Task-tag → skill routing (92_runtime_skill_routing_plan). Tags are normalized
// task_tags from dispatch; they add skill pointers without changing the execution role.
const TASK_TAG_SKILL_MAP: Record<string, string[]> = {
    frontend_ui: ['dev-uiux-design'],
    testing: ['dev-testing'],
    tdd: ['dev-testing'],
    bdd_acceptance: ['dev-testing', 'dev'],
    security: ['dev-security'],
    threat_model: ['dev-security'],
    architecture: ['dev-architecture', 'dev-backend'],
    ddd: ['dev-architecture', 'dev-backend'],
    clean_arch: ['dev-architecture', 'dev-backend'],
    hexagonal: ['dev-architecture', 'dev-backend'],
    vertical_slice: ['dev-architecture', 'dev-backend', 'dev-frontend', 'dev-testing'],
    adr_rfc: ['dev-architecture', 'dev-scaffolding'],
    review: ['dev-code-reviewer'],
    code_review: ['dev-code-reviewer'],
    debugging: ['dev-debugging'],
    debugging_rca: ['dev-debugging'],
    observability: ['dev-backend'],
    observability_pipeline: ['dev-backend', 'dev-data'],
    migration_backfill: ['dev-data', 'dev-backend', 'dev-testing'],
    product_discovery: ['dev'],
    product_discovery_ui: ['dev', 'dev-uiux-design'],
    release_cd: ['dev-testing', 'dev-backend', 'dev-scaffolding'],
    crud_fullstack: ['dev-backend', 'dev-frontend', 'dev-testing'],
};

export function normalizeTaskTags(raw: unknown): string[] {
    // Bare string is coerced to a single tag (dev §0.3); separators that would
    // collide with the comma-joined cache key are normalized to underscores.
    const arr = typeof raw === 'string' ? [raw] : raw;
    if (!Array.isArray(arr)) return [];
    return [...new Set(
        arr.filter((t): t is string => typeof t === 'string')
            .map(t => t.trim().toLowerCase().replace(/[\s,:;-]+/g, '_'))
            .filter(Boolean),
    )].sort();
}

export function getEmployeePromptV2(
    emp: { name: string; role?: string; id?: string | number; cli?: string },
    role: string,
    currentPhase: number | string,
    opts?: { mutable?: boolean; scope?: string | null; taskTags?: string[] },
) {
    const phase = Number(currentPhase);
    const taskTags = normalizeTaskTags(opts?.taskTags);
    const mcpSummary = getEmployeeMcpToolSummary();
    const mcpHash = mcpSummary ? createHash('md5').update(mcpSummary).digest('hex').slice(0, 8) : '';
    const cacheKey = `${emp.id || emp.name}:${emp.cli || ''}:${role}:${phase}:${settings["workingDir"] || '~'}:${opts?.mutable ? 'mut' : 'ro'}:${opts?.scope || ''}:${taskTags.join(',')}:${mcpHash}`;
    if (promptCache.has(cacheKey)) return promptCache.get(cacheKey);

    let prompt = getEmployeePrompt(emp);

    // --mutable: override the hard read-only block in employee.md
    if (opts?.mutable) {
        prompt = prompt.replace(
            /- ⛔ Do NOT create, modify, or delete files\..*/,
            `- ✅ You are authorized to create or modify files${opts.scope ? ` inside \`${opts.scope}\`` : ''}. Protected paths (.git, .env, settings.json) remain blocked.`,
        );
    }

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

    // Skill bodies are intentionally not inlined. Each employee receives a
    // compact path contract and reads only the guide needed for the task.
    const devCommonPath = findSkillPath('dev');
    const scaffoldingPath = findSkillPath('dev-scaffolding');

    const ROLE_SKILL_NAME_MAP = {
        frontend: 'dev-frontend',
        backend: 'dev-backend',
        data: 'dev-data',
        docs: 'dev-scaffolding',
        custom: null,
    };

    const roleSkillName = (ROLE_SKILL_NAME_MAP as Record<string, string | null>)[role] ?? null;
    const roleSkillPath = roleSkillName ? findSkillPath(roleSkillName) : null;
    const pabcdPath = findSkillPath('dev-pabcd');
    const reviewerPath = findSkillPath('dev-code-reviewer');
    const testingPath = findSkillPath('dev-testing');

    prompt += `\n\n## Skill Loading Contract`;
    prompt += `\nSkill bodies are not preloaded. Read each guide once, only when the task requires it.`;
    prompt += `\n- Match by intent, not exact words: compare the task, files, domain nouns, output, and task verbs against visible skill names, descriptions, and any listed metadata, keywords, or triggers.`;
    prompt += `\n- When uncertain, inspect the best candidate: if metadata suggests a plausible match, read that SKILL.md once before deciding it does not apply.`;
    prompt += `\n- Search intent override: for "검색", "검색해", "찾아봐", "알아봐", "look up", or "search" targeting external/current/docs/library information, inspect the active search skill before local Grep/Glob.`;
    if (emp.cli === 'agy') {
        prompt += `\n\n## AGY Search Grounding Rules`;
        prompt += `\nAGY/Gemini search summaries are orientation only, not final evidence.`;
        prompt += `\n- For Korean external/current/source-sensitive search tasks, rewrite the request into 1-3 focused Korean keyword queries that preserve source hints, dates, domains, and content type.`;
        prompt += `\n- Treat search_web output as URL candidates only. Do not claim original-source verification from a search summary.`;
        prompt += `\n- If the request asks for 원문, 특정 후기, 정확한 문구, 표/목록/순위, 실시간 상태, 현재 수치, 공식 공고, or source-of-truth verification, fetch/open the original candidate URL when tools allow it.`;
        prompt += `\n- If fetch/open/browser tools are unavailable or not used, explicitly say the answer is not original-source verified.`;
        prompt += `\n- For Naver Blog/Cafe, iframe shells, JS-rendered pages, official dashboards, live standings, tables, pagination, or login-gated surfaces, state that browser/browse verification is required instead of saying the snippet is enough.`;
        prompt += `\n- In final search notes, label evidence state as VERIFIED_BY_ORIGINAL_SOURCE, CANDIDATE_ONLY_NEEDS_FETCH, or NEEDS_BROWSER_VERIFICATION.`;
    }
    prompt += `\n- Common dev guide: ${formatSkillPath('dev', devCommonPath)}`;
    prompt += `\n- Scaffolding guide: ${formatSkillPath('dev-scaffolding', scaffoldingPath)} (read only for new projects, new modules, or structure audits)`;
    if (staticSpec?.skills?.length) {
        prompt += `\n- Static employee skills:`;
        for (const skillName of staticSpec.skills) {
            prompt += `\n  - ${formatSkillPath(skillName, findSkillPath(skillName))}`;
        }
    }

    prompt += `\n\n## Role Contract`;
    prompt += `\n- Role: ${role}`;
    prompt += `\n- Role guide: ${roleSkillName ? formatSkillPath(roleSkillName, roleSkillPath) : 'none'}`;
    prompt += `\n- Apply this role on every assigned task. Before role-specific implementation or review, read the role guide once if it is available.`;
    prompt += `\n- Also read the common dev guide before modifying code.`;

    // Task-tag overlays: extra skill pointers, de-duplicated against the role
    // skill and the always-present common guides. Tags never change the role.
    if (taskTags.length > 0) {
        const baseSkills = new Set(['dev', 'dev-scaffolding', roleSkillName].filter(Boolean) as string[]);
        const tagSkills: string[] = [];
        const unknownTags: string[] = [];
        for (const tag of taskTags) {
            const mapped = TASK_TAG_SKILL_MAP[tag];
            if (!mapped) { unknownTags.push(tag); continue; }
            for (const skillName of mapped) {
                if (!baseSkills.has(skillName) && !tagSkills.includes(skillName)) tagSkills.push(skillName);
            }
        }
        {
            // Render whenever tags exist — even if every mapped skill deduped
            // against base skills (e.g. product_discovery → dev), so the tag
            // stays visible to the employee.
            prompt += `\n\n## Task Tag Guides`;
            prompt += `\n- Task tags for this dispatch: ${taskTags.join(', ')}. Tags add guidance; your execution role stays "${role}".`;
            for (const skillName of tagSkills) {
                prompt += `\n- ${formatSkillPath(skillName, findSkillPath(skillName))} (read once before work the tag covers)`;
            }
            if (unknownTags.length > 0) {
                prompt += `\n- Unrecognized tags (no extra guide): ${unknownTags.join(', ')}`;
            }
        }
    }

    prompt += `\n\n## Phase Guide`;
    prompt += `\n- Use the phase context below as the source of truth for what this employee should do now.`;
    prompt += `\n- Full PABCD guide: ${formatSkillPath('dev-pabcd', pabcdPath)} (read only if phase rules are unclear).`;
    if (phase === 2) {
        prompt += `\n- Phase 2 audit: read ${formatSkillPath('dev-code-reviewer', reviewerPath)} before reviewing plans or code.`;
    } else if (phase === 4) {
        prompt += `\n- Phase 4 check: read ${formatSkillPath('dev-testing', testingPath)} before designing or running verification.`;
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
    prompt += `\n- Your process cwd may be an isolated temporary directory. Do NOT treat process.cwd() as the repository root.`;
    prompt += `\n- Use the task's ## Workspace Context block as the source of truth for Project root and Devlog root.`;
    prompt += `\n- Resolve relative repository paths against Project root, and always use absolute paths in commands and reports.`;

    prompt += `\n\n${getBoundedLocalSearchContract()}`;

    prompt += `\n\n## Delegation Rules`;
    prompt += `\n- Execute the assigned task directly in this employee session.`;
    prompt += `\n- You CAN use CLI sub-agents (Task/Agent tool) for parallel work: research, file reads, code analysis. This is encouraged.`;
    prompt += `\nWhen spawning a sub-agent, include: "Do NOT use Agent, subagent, or delegation tools. Do all work directly."`;
    prompt += `\n- ⛔ Do NOT run \`cli-jaw dispatch\` or any equivalent delegation command from this session.`;
    prompt += `\n- ⛔ Do NOT output jaw dispatch JSON or subtask JSON.`;
    prompt += `\n- ⛔ Do NOT describe Boss/employee orchestration structure in your answer.`;

    if (mcpSummary) {
        prompt += `\n\n${mcpSummary}`;
    }

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
        const wd = settings["workingDir"] || os.homedir();
        fs.writeFileSync(join(wd, 'AGENTS.md'), fullPrompt);
        console.log(`[prompt] AGENTS.md generated at ${wd}`);
    } catch (e: unknown) {
        console.error(`[prompt] AGENTS.md generation failed:`, (e as Error).message);
    }
}
