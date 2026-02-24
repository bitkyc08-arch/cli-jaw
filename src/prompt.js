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

## Browser Control (MANDATORY)
When the user asks you to browse the web, fill forms, take screenshots, or interact with any website:
- You MUST use \`cli-claw browser\` commands. Do NOT attempt manual curl/wget scraping.
- Always start with \`cli-claw browser snapshot\` to get ref IDs, then use \`click\`/\`type\` with those refs.
- Follow the pattern: snapshot → act → snapshot → verify.
- If the browser is not started, run \`cli-claw browser start\` first.
- Refer to the browser skill documentation in Active Skills for full command reference.

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
      "name": "작업 이름",
      "enabled": true,
      "schedule": { "kind": "every", "minutes": 5 },
      "prompt": "매 실행마다 보낼 프롬프트"
    }
  ]
}
\\\`\\\`\\\`

### Rules
- id는 "hb_" + Date.now() 형식
- enabled: true이면 자동 실행, false면 일시정지
- schedule.minutes: 실행 간격 (분)
- prompt: 실행 시 에이전트에게 전달되는 프롬프트
- 결과는 자동으로 Telegram에 전송됨
- 할 일이 없는 heartbeat에는 [SILENT]로 응답
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

    // Core memory (MEMORY.md, 시스템 레벨 주입)
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
                `- "${e.name}" (CLI: ${e.cli}) — ${e.role || '범용 개발자'}`
            ).join('\n');
            const example = emps[0].name;
            prompt += '\n\n---\n';
            prompt += '\n## Orchestration System';
            prompt += '\nYou have external employees (separate CLI processes).';
            prompt += '\nThe middleware detects your JSON output and AUTOMATICALLY spawns employees.';
            prompt += `\n\n### Available Employees\n${list}`;
            prompt += '\n\n### Dispatch Format';
            prompt += '\nTo assign work, output EXACTLY this format (triple-backtick fenced JSON block):';
            prompt += `\n\n\\\`\\\`\\\`json\n{\n  "subtasks": [\n    {\n      "agent": "${example}",\n      "task": "구체적인 작업 지시",\n      "priority": 1\n    }\n  ]\n}\n\\\`\\\`\\\``;
            prompt += '\n\n### CRITICAL RULES';
            prompt += '\n1. JSON은 반드시 \\`\\`\\`json ... \\`\\`\\` 코드블럭으로 감싸야 함 (필수)';
            prompt += '\n2. 코드블럭 없는 raw JSON 출력 금지';
            prompt += '\n3. agent 이름은 위 목록과 정확히 일치해야 함';
            prompt += '\n4. 실행 가능한 요청이면 반드시 subtask JSON 출력';
            prompt += '\n5. "결과 보고"를 받으면 사용자에게 자연어로 요약';
            prompt += '\n6. 직접 답변할 수 있는 질문이면 JSON 없이 자연어로 응답';
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

            // 2. Ref skills — available for on-demand use
            if (availableRef.length > 0) {
                prompt += `\n### Available Skills (${availableRef.length})\n`;
                prompt += 'These skills are available but not active. ';
                prompt += 'When the user requests a related task, read the SKILL.md file and follow its instructions.\n';
                for (const s of availableRef) {
                    const refPath = join(SKILLS_REF_DIR, s.id, 'SKILL.md');
                    prompt += `- ${s.emoji || '🔧'} ${s.name}: ${s.description} → \`${refPath}\`\n`;
                }
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
    let prompt = `# ${emp.name}\n역할: ${emp.role || '범용 개발자'}\n`;

    // ─── 핵심 규칙 (오케스트레이션 규칙 의도적 제외 → 재귀 루프 방지)
    prompt += `\n## 규칙\n`;
    prompt += `- 주어진 작업을 직접 실행하고 결과를 보고하세요\n`;
    prompt += `- JSON subtask 출력 금지 (당신은 실행자이지 기획자가 아닙니다)\n`;
    prompt += `- 작업 결과를 자연어로 간결하게 보고하세요\n`;
    prompt += `- 사용자 언어로 응답하세요\n`;

    // ─── 브라우저 명령어
    prompt += `\n## Browser Control\n`;
    prompt += `웹 작업 시 \`cli-claw browser\` 명령어를 반드시 사용하세요.\n`;
    prompt += `패턴: snapshot → act → snapshot → verify\n`;
    prompt += `시작: \`cli-claw browser start\`, 스냅샷: \`cli-claw browser snapshot\`\n`;
    prompt += `클릭: \`cli-claw browser click <ref>\`, 입력: \`cli-claw browser type <ref> "텍스트"\`\n`;

    // ─── Active Skills (동적 로딩)
    try {
        const activeSkills = loadActiveSkills();
        if (activeSkills.length > 0) {
            prompt += `\n## Active Skills (${activeSkills.length})\n`;
            prompt += `설치된 스킬 — CLI가 자동 트리거합니다.\n`;
            for (const s of activeSkills) {
                prompt += `- ${s.name} (${s.id})\n`;
            }
        }
    } catch { /* skills not ready */ }

    // ─── 메모리 명령어
    prompt += `\n## Memory\n`;
    prompt += `장기 기억: \`cli-claw memory search/read/save\` 명령어 사용.\n`;

    return prompt;
}

export function regenerateB() {
    const fullPrompt = getSystemPrompt();
    fs.writeFileSync(join(PROMPTS_DIR, 'B.md'), fullPrompt);

    // Generate CODEX.md in workingDir for compact-protected system prompt
    // Codex reads .codex/AGENTS.md or CODEX.md automatically
    try {
        const wd = settings.workingDir || os.homedir();
        const codexDir = join(wd, '.codex');
        fs.mkdirSync(codexDir, { recursive: true });
        fs.writeFileSync(join(codexDir, 'AGENTS.md'), fullPrompt);
        console.log(`[prompt] CODEX AGENTS.md generated at ${codexDir}`);
    } catch (e) {
        console.error(`[prompt] CODEX AGENTS.md generation failed:`, e.message);
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
