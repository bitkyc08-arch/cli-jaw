import fs from 'fs';
import os from 'os';
import { join } from 'path';
import { settings, CLAW_HOME, PROMPTS_DIR, SKILLS_DIR, SKILLS_REF_DIR, loadHeartbeatFile } from './config.js';
import { getSession, updateSession, getEmployees } from './db.js';
import { memoryFlushCounter, flushCycleCount } from './agent.js';

// ─── Skill Loading ───────────────────────────────────

/** Read all active skills from ~/.cli-claw/skills/ */
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
        return Object.entries(reg.skills || {}).map(([id, s]) => ({ id, ...s }));
    } catch { return []; }
}

/** Get merged skill list (active + ref) for API */
export function getMergedSkills() {
    const active = loadActiveSkills();
    const activeIds = new Set(active.map(s => s.id));
    const ref = loadSkillRegistry();
    const merged = [];

    // Active skills (from skills/)
    for (const s of active) {
        const refInfo = ref.find(r => r.id === s.id);
        merged.push({
            id: s.id,
            name: refInfo?.name || s.name,
            emoji: refInfo?.emoji || '🔧',
            category: refInfo?.category || 'installed',
            description: refInfo?.description || s.description,
            requires: refInfo?.requires || null,
            install: refInfo?.install || null,
            enabled: true,
            source: activeIds.has(s.id) && ref.find(r => r.id === s.id) ? 'both' : 'active',
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

const A1_CONTENT = `# Claw Agent

You are Claw Agent, a system-level AI assistant.
Execute tasks on the user's computer via CLI tools.

## Rules
- Follow the user's instructions precisely
- Respond in the user's language
- Report results clearly with file paths and outputs
- Ask for clarification when ambiguous
- Never run git commit/push/branch/reset/clean unless the user explicitly asks in the same turn
- Default delivery is file changes + verification report (no commit/push)

## Browser Control (MANDATORY)
When the user asks you to browse the web, fill forms, take screenshots, or interact with any website:
- You MUST use \`cli-claw browser\` commands. Do NOT attempt manual curl/wget scraping.
- Always start with \`cli-claw browser snapshot\` to get ref IDs, then use \`click\`/\`type\` with those refs.
- Follow the pattern: snapshot → act → snapshot → verify.
- If the browser is not started, run \`cli-claw browser start\` first.
- Refer to the browser skill documentation in Active Skills for full command reference.

## Telegram File Delivery
When non-text output must be delivered to Telegram (voice/photo/document), use:
\`POST http://localhost:3457/api/telegram/send\`

- Supported types: \`text\`, \`voice\`, \`photo\`, \`document\`
- For non-text types, pass \`file_path\` (absolute local path)
- If \`chat_id\` is omitted, server uses the latest active Telegram chat
- Always provide a normal text response alongside file delivery

## Long-term Memory (MANDATORY)
You have two memory sources:
- Core memory: ~/.cli-claw/memory/ (manual, structured)
- Session memory: ~/.claude/projects/.../memory/ (auto-flush)
- At conversation start: ALWAYS read MEMORY.md for core knowledge.
- Before answering about past decisions, preferences, people: search memory first.
- After important decisions or user preferences: save to memory immediately.
- Use \`cli-claw memory search/read/save\` commands. See memory skill for details.

## Heartbeat System
You can register recurring scheduled tasks via ~/.cli-claw/heartbeat.json.
The file is auto-reloaded on change — just write it and the system picks it up.

### JSON Format
\\\`\\\`\\\`json
{
  "jobs": [
    {
      "id": "hb_<timestamp>",
      "name": "Job name",
      "enabled": true,
      "schedule": { "kind": "every", "minutes": 5 },
      "prompt": "Prompt sent every execution"
    }
  ]
}
\\\`\\\`\\\`

### Rules
- id format: "hb_" + Date.now()
- enabled: true = auto-run, false = paused
- schedule.minutes: execution interval (minutes)
- prompt: sent to the agent each execution
- Results are automatically forwarded to Telegram
- If nothing to report, respond with [SILENT]
`;

const A2_DEFAULT = `# User Configuration

## Identity
- Name: Claw
- Emoji: 🦞

## User
- Name: (your name)
- Language: English
- Timezone: UTC

## Vibe
- Friendly, warm
- Technically accurate

## Working Directory
- ~/
`;

const HEARTBEAT_DEFAULT = `# Heartbeat checklist

<!-- Keep this empty to skip heartbeat API calls -->
<!-- Add tasks below when you want periodic checks -->
`;

// ─── Paths ───────────────────────────────────────────

export const A1_PATH = join(PROMPTS_DIR, 'A-1.md');
export const A2_PATH = join(PROMPTS_DIR, 'A-2.md');
export const HEARTBEAT_PATH = join(PROMPTS_DIR, 'HEARTBEAT.md');

// ─── Initialize prompt files ─────────────────────────

export function initPromptFiles() {
    if (!fs.existsSync(A1_PATH)) fs.writeFileSync(A1_PATH, A1_CONTENT);
    if (!fs.existsSync(A2_PATH)) fs.writeFileSync(A2_PATH, A2_DEFAULT);
    if (!fs.existsSync(HEARTBEAT_PATH)) fs.writeFileSync(HEARTBEAT_PATH, HEARTBEAT_DEFAULT);
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

export function getSystemPrompt() {
    const a1 = fs.readFileSync(A1_PATH, 'utf8');
    const a2 = fs.existsSync(A2_PATH) ? fs.readFileSync(A2_PATH, 'utf8') : '';
    let prompt = `${a1}\n\n${a2}`;

    // Telegram send guidance for existing installs (A-1.md migration-safe)
    try {
        const tgSkillPath = join(SKILLS_DIR, 'telegram-send', 'SKILL.md');
        if (fs.existsSync(tgSkillPath)) {
            prompt += '\n\n## Telegram File Delivery (Active)\n';
            prompt += '- Use `POST http://localhost:3457/api/telegram/send` for non-text Telegram output.\n';
            prompt += '- Types: `voice`, `photo`, `document` (and optional `text` for intermediate notices).\n';
            prompt += '- Required for non-text: `type` + `file_path`.\n';
            prompt += '- Add `chat_id` when needed; if omitted, latest active Telegram chat is used.\n';
            prompt += '- Keep your regular text response in stdout as usual.\n';
        }
    } catch { /* telegram-send skill not ready */ }

    // Auto-flush memories (threshold-based injection)
    // Inject every ceil(threshold/2) messages: threshold=5 → inject at 0,3,5,8,10...
    try {
        const threshold = settings.memory?.flushEvery ?? 20;
        const injectInterval = Math.ceil(threshold / 2);
        const shouldInject = memoryFlushCounter % injectInterval === 0;
        if (shouldInject) {
            const memories = loadRecentMemories();
            if (memories) {
                prompt += memories;
                console.log(`[memory] injected (msg ${memoryFlushCounter}, every ${injectInterval})`);
            }
        } else {
            console.log(`[memory] skipped injection (msg ${memoryFlushCounter}/${threshold}, interval ${injectInterval})`);
        }
    } catch {
        // Fallback: always inject if counter unavailable
        const memories = loadRecentMemories();
        if (memories) prompt += memories;
    }

    // Core memory (MEMORY.md, system-level injection)
    try {
        const memPath = join(CLAW_HOME, 'memory', 'MEMORY.md');
        if (fs.existsSync(memPath)) {
            const coreMem = fs.readFileSync(memPath, 'utf8').trim();
            if (coreMem && coreMem.length > 50) {
                const truncated = coreMem.length > 1500
                    ? coreMem.slice(0, 1500) + '\n...(use `cli-claw memory read MEMORY.md` for full)'
                    : coreMem;
                prompt += '\n\n---\n## Core Memory\n' + truncated;
                console.log(`[memory] MEMORY.md loaded: ${truncated.length} chars`);
            }
        }
    } catch { /* memory not ready */ }

    try {
        const emps = getEmployees.all();
        if (emps.length > 0) {
            const list = emps.map(e =>
                `- "${e.name}" (CLI: ${e.cli}) — ${e.role || 'general developer'}`
            ).join('\n');
            const example = emps[0].name;
            prompt += '\n\n---\n';
            prompt += '\n## Orchestration System';
            prompt += '\nYou have external employees (separate CLI processes).';
            prompt += '\nThe middleware detects your JSON output and AUTOMATICALLY spawns employees.';
            prompt += `\n\n### Available Employees\n${list}`;
            prompt += '\n\n### Dispatch Format';
            prompt += '\nTo assign work, output EXACTLY this format (triple-backtick fenced JSON block):';
            prompt += `\n\n\\\`\\\`\\\`json\n{\n  "subtasks": [\n    {\n      "agent": "${example}",\n      "task": "Specific task instruction",\n      "priority": 1\n    }\n  ]\n}\n\\\`\\\`\\\``;
            prompt += '\n\n### CRITICAL RULES';
            prompt += '\n1. JSON MUST be wrapped in ```json ... ``` code blocks (mandatory)';
            prompt += '\n2. Never output raw JSON without code blocks';
            prompt += '\n3. Agent name must exactly match the list above';
            prompt += '\n4. If the request is actionable, always output subtask JSON';
            prompt += '\n5. When receiving a "result report", summarize it in natural language for the user';
            prompt += '\n6. If you can answer directly, respond in natural language without JSON';
        }
    } catch { /* DB not ready yet */ }

    try {
        const hbData = loadHeartbeatFile();
        if (hbData.jobs.length > 0) {
            const activeJobs = hbData.jobs.filter(j => j.enabled);
            prompt += '\n\n---\n## Current Heartbeat Jobs\n';
            for (const job of hbData.jobs) {
                const status = job.enabled ? '✅' : '⏸️';
                const mins = job.schedule?.minutes || '?';
                prompt += `- ${status} "${job.name}" — every ${mins}min: ${(job.prompt || '').slice(0, 50)}\n`;
            }
            prompt += `\nActive: ${activeJobs.length}, Total: ${hbData.jobs.length}`;
            prompt += '\nTo modify: edit ~/.cli-claw/heartbeat.json (auto-reloads on save)';
        }
    } catch { /* heartbeat.json not ready */ }

    // ─── Skills (Phase 6) ────────────────────────────
    // Active skills are loaded by CLI tools natively via .agents/skills/ symlink.
    // We only inject: (1) active skill names, (2) ref skill list, (3) search/create instruction.
    try {
        const activeSkills = loadActiveSkills();
        const refSkills = loadSkillRegistry();
        const activeIds = new Set(activeSkills.map(s => s.id));
        const availableRef = refSkills.filter(s => !activeIds.has(s.id));

        if (activeSkills.length > 0 || availableRef.length > 0) {
            prompt += '\n\n---\n## Skills System\n';

            // 1. Active skills — name list only (CLI handles trigger/execution)
            if (activeSkills.length > 0) {
                prompt += `\n### Active Skills (${activeSkills.length})\n`;
                prompt += 'These skills are installed and triggered automatically by the CLI.\n';
                for (const s of activeSkills) {
                    prompt += `- ${s.name} (${s.id})\n`;
                }
            }

            // 2. Ref skills — compact name list (full details in skills_ref/)
            if (availableRef.length > 0) {
                prompt += `\n### Available Skills (${availableRef.length})\n`;
                prompt += 'These are reference skills — not active yet, but ready to use on demand.\n';
                prompt += '**How to use**: read `~/.cli-claw/skills_ref/<name>/SKILL.md` and follow its instructions.\n';
                prompt += '**To activate permanently**: `cli-claw skill install <name>`\n\n';
                prompt += availableRef.map(s => s.id).join(', ') + '\n';
            }

            // 3. Search or create instruction
            prompt += '\n### Skill Discovery\n';
            prompt += 'If a requested task is not covered by any active or available skill:\n';
            prompt += '1. Search the system for relevant CLI tools that can accomplish the task.\n';
            prompt += '2. If a suitable tool exists, create a new SKILL.md and save it to the skills directory.\n';
            prompt += '3. Use the skill-creator reference if available for formatting guidance.\n';
        }
    } catch { /* skills not ready */ }

    // ─── Vision-Click Hint (Codex only) ──────────────
    try {
        const session = getSession();
        if (session.active_cli === 'codex') {
            const visionSkillPath = join(SKILLS_DIR, 'vision-click', 'SKILL.md');
            if (fs.existsSync(visionSkillPath)) {
                prompt += '\n### Vision Click (Active)\n';
                prompt += '- If browser snapshot shows no ref for target, use vision-click: screenshot → `codex exec -i` → `mouse-click <x> <y>`.\n';
                prompt += '- See vision-click skill SKILL.md for full workflow.\n';
            }
        }
    } catch { /* vision-click not ready */ }

    return prompt;
}

// ─── Sub-Agent Prompt (orchestration-free) ───────────

export function getSubAgentPrompt(emp) {
    let prompt = `# ${emp.name}\nRole: ${emp.role || 'general developer'}\n`;

    // ─── Core rules (orchestration rules intentionally excluded → prevent recursion)
    prompt += `\n## Rules\n`;
    prompt += `- Execute the given task directly and report the results\n`;
    prompt += `- Do NOT output JSON subtasks (you are an executor, not a planner)\n`;
    prompt += `- Report results concisely in natural language\n`;
    prompt += `- Respond in the user's language\n`;
    prompt += `- Never run git commit/push/branch/reset/clean unless the user explicitly asks\n`;

    // ─── Browser commands
    prompt += `\n## Browser Control\n`;
    prompt += `For web tasks, always use \`cli-claw browser\` commands.\n`;
    prompt += `Pattern: snapshot → act → snapshot → verify\n`;
    prompt += `Start: \`cli-claw browser start\`, Snapshot: \`cli-claw browser snapshot\`\n`;
    prompt += `Click: \`cli-claw browser click <ref>\`, Type: \`cli-claw browser type <ref> "text"\`\n`;

    // ─── Telegram file delivery
    prompt += `\n## Telegram File Delivery\n`;
    prompt += `For non-text output, use \`POST /api/telegram/send\`.\n`;
    prompt += `Types: \`voice|photo|document\` (optionally \`text\`)\n`;
    prompt += `Required for non-text: \`type\` + \`file_path\`\n`;
    prompt += `Specify \`chat_id\` when possible; if omitted, the latest active chat is used.\n`;
    prompt += `Always provide a natural language text report alongside file delivery.\n`;

    // ─── Active Skills (dynamic loading)
    try {
        const activeSkills = loadActiveSkills();
        if (activeSkills.length > 0) {
            prompt += `\n## Active Skills (${activeSkills.length})\n`;
            prompt += `Installed skills — automatically triggered by the CLI.\n`;
            for (const s of activeSkills) {
                prompt += `- ${s.name} (${s.id})\n`;
            }
        }
    } catch { /* skills not ready */ }

    // ─── Memory commands
    prompt += `\n## Memory\n`;
    prompt += `Long-term memory: use \`cli-claw memory search/read/save\` commands.\n`;

    return prompt;
}

// ─── Sub-Agent Prompt v2 (orchestration phase-aware) ─

export function getSubAgentPromptV2(emp, role, currentPhase) {
    let prompt = getSubAgentPrompt(emp);

    // ─── 1. 공통 Dev 스킬 (항상 주입)
    const devCommonPath = join(SKILLS_DIR, 'dev', 'SKILL.md');
    if (fs.existsSync(devCommonPath)) {
        prompt += `\n\n## Development Guide (Common)\n${fs.readFileSync(devCommonPath, 'utf8')}`;
    }

    // ─── 2. Role 기반 Dev 스킬 주입
    const ROLE_SKILL_MAP = {
        frontend: join(SKILLS_DIR, 'dev-frontend', 'SKILL.md'),
        backend: join(SKILLS_DIR, 'dev-backend', 'SKILL.md'),
        data: join(SKILLS_DIR, 'dev-data', 'SKILL.md'),
        docs: join(SKILLS_DIR, 'documentation', 'SKILL.md'),
        custom: null,
    };

    const skillPath = ROLE_SKILL_MAP[role];
    if (skillPath && fs.existsSync(skillPath)) {
        prompt += `\n\n## Development Guide (${role})\n${fs.readFileSync(skillPath, 'utf8')}`;
    }

    // ─── 3. 디버깅 phase(4) → dev-testing 추가 주입
    if (currentPhase === 4) {
        const testingPath = join(SKILLS_DIR, 'dev-testing', 'SKILL.md');
        if (fs.existsSync(testingPath)) {
            prompt += `\n\n## Testing Guide (Phase 4)\n${fs.readFileSync(testingPath, 'utf8')}`;
        }
    }

    // ─── 4. Phase 컨텍스트 + Quality Gate
    const PHASES = { 1: 'Planning', 2: 'Plan Review', 3: 'Development', 4: 'Debugging', 5: 'Integration' };
    const PHASE_GATES = {
        1: 'Gate: impact analysis + dependency check + edge case list complete',
        2: 'Gate: code cross-check + conflict scan + test strategy established',
        3: 'Gate: changed file list + export/import integrity + zero build errors',
        4: 'Gate: execution evidence + bug fix log + edge case test results',
        5: 'Gate: integration tests + docs updated + workflow verified',
    };
    prompt += `\n\n## Current Phase: ${currentPhase} (${PHASES[currentPhase]})`;
    prompt += `\nYou are currently executing the "${PHASES[currentPhase]}" phase.`;
    prompt += `\n${PHASE_GATES[currentPhase]}`;
    prompt += `\n\n## Sequential Execution + Phase Skip`;
    prompt += `\nAgents run one at a time in order. Previous agents' results are already reflected in the files.`;
    prompt += `\n- Read the worklog first to understand what previous agents did`;
    prompt += `\n- Do not touch files already modified by others`;
    prompt += `\n- Focus only on your assigned area`;
    prompt += `\n- If current Phase > 1, previous Phases are already complete. Do not redo planning/review.`;
    prompt += `\n\nNote: You must meet ALL gate conditions above to pass the Quality Gate. Incomplete work will be retried.`;

    return prompt;
}

export function regenerateB() {
    const fullPrompt = getSystemPrompt();
    fs.writeFileSync(join(PROMPTS_DIR, 'B.md'), fullPrompt);

    // Generate {workDir}/AGENTS.md — read by Codex, Copilot, and OpenCode
    try {
        const wd = settings.workingDir || os.homedir();
        fs.writeFileSync(join(wd, 'AGENTS.md'), fullPrompt);
        console.log(`[prompt] AGENTS.md generated at ${wd}`);
    } catch (e) {
        console.error(`[prompt] AGENTS.md generation failed:`, e.message);
    }

    try {
        const session = getSession();
        if (session.session_id) {
            updateSession.run(session.active_cli, null, session.model,
                session.permissions, session.working_dir, session.effort);
            console.log('[claw:session] invalidated — B.md changed');
        }
    } catch { /* DB not ready yet */ }
}
