// ─── Worklog: create / read / append / update ────────
// Manages per-orchestration worklog files + latest.md symlink

import fs from 'fs';
import { join } from 'path';
import { CLAW_HOME } from '../core/config.js';

// ─── Write Lock (prevents race condition in parallel agent writes) ──
const writeLocks = new Map<string, Promise<void>>();

function withWriteLock(filePath: string, fn: () => void): void {
    const prev = writeLocks.get(filePath) || Promise.resolve();
    const next = prev.then(() => {
        fn();
    }).catch(e => {
        console.error(`[worklog:lock] write error for ${filePath}:`, (e as Error).message);
    });
    writeLocks.set(filePath, next);
}

export const WORKLOG_DIR = join(CLAW_HOME, 'worklogs');
const LATEST_LINK = join(WORKLOG_DIR, 'latest.md');

// Phase 번호 매핑 (orchestrator.js와 공유)
export const PHASES = {
    1: '기획',
    2: '기획검증',
    3: '개발',
    4: '디버깅',
    5: '통합검증',
};

// ─── Create ──────────────────────────────────────────

export function createWorklog(prompt: string) {
    fs.mkdirSync(WORKLOG_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:-]/g, '').slice(0, 15);
    const slug = prompt.slice(0, 30).replace(/[^a-zA-Z가-힣0-9]/g, '_');
    const filename = `${ts}_${slug}.md`;
    const path = join(WORKLOG_DIR, filename);

    const initial = `# Work Log: ${prompt.slice(0, 80)}
- Created: ${new Date().toISOString()}
- Status: planning
- Rounds: 0/3

## Plan
(대기 중)

## Verification Criteria
(대기 중)

## Agent Status Matrix
| Agent | Role | Phase | Gate |
|-------|------|-------|------|

## Execution Log

## Final Summary
(미완료)
`;

    fs.writeFileSync(path, initial);

    // symlink 갱신
    try { fs.unlinkSync(LATEST_LINK); } catch { /* first run */ }
    fs.symlinkSync(path, LATEST_LINK);

    console.log(`[worklog] created: ${filename}`);
    return { path, filename };
}

// ─── Read ────────────────────────────────────────────

export function readLatestWorklog() {
    if (!fs.existsSync(LATEST_LINK)) return null;
    try {
        const realPath = fs.realpathSync(LATEST_LINK);
        return { path: realPath, content: fs.readFileSync(realPath, 'utf8') };
    } catch {
        return null;
    }
}

// ─── Append ──────────────────────────────────────────

export function appendToWorklog(wlPath: string, section: string, content: string) {
    if (!wlPath || !fs.existsSync(wlPath)) return;

    withWriteLock(wlPath, () => {
        const file = fs.readFileSync(wlPath, 'utf8');
        const marker = `## ${section}`;
        const idx = file.indexOf(marker);

        if (idx === -1) {
            // 섹션이 없으면 끝에 추가
            fs.appendFileSync(wlPath, `\n## ${section}\n${content}\n`);
        } else {
            // 섹션 헤더 뒤, 다음 섹션 앞에 삽입
            const nextSection = file.indexOf('\n## ', idx + marker.length);
            const insertPos = nextSection === -1 ? file.length : nextSection;
            const updated = file.slice(0, insertPos) + '\n' + content + '\n' + file.slice(insertPos);
            fs.writeFileSync(wlPath, updated);
        }
    });
}

// ─── Matrix Update ───────────────────────────────────

export function updateMatrix(wlPath: string, agentPhases: Array<Record<string, any>>) {
    if (!wlPath || !fs.existsSync(wlPath)) return;

    withWriteLock(wlPath, () => {
        const table = agentPhases.map((ap: Record<string, any>) =>
            `| ${ap.agent} | ${ap.role} | Phase ${ap.currentPhase}: ${(PHASES as Record<string, string>)[ap.currentPhase] || '?'} | ${ap.completed ? '✅ 완료' : '⏳ 진행 중'} |`
        ).join('\n');

        const file = fs.readFileSync(wlPath, 'utf8');
        const header = '## Agent Status Matrix';
        const start = file.indexOf(header);
        if (start === -1) return;

        const nextSection = file.indexOf('\n## ', start + header.length);
        const replacement = `${header}\n| Agent | Role | Phase | Gate |\n|-------|------|-------|------|\n${table}\n`;

        const updated = nextSection === -1
            ? file.slice(0, start) + replacement
            : file.slice(0, start) + replacement + file.slice(nextSection);

        fs.writeFileSync(wlPath, updated);
    });
}

// ─── Status Update ───────────────────────────────────

export function updateWorklogStatus(wlPath: string, status: string, round: number) {
    if (!wlPath || !fs.existsSync(wlPath)) return;

    withWriteLock(wlPath, () => {
        const file = fs.readFileSync(wlPath, 'utf8');
        const updated = file
            .replace(/- Status: .*/, `- Status: ${status}`)
            .replace(/- Rounds: .*/, `- Rounds: ${round}/3`);
        fs.writeFileSync(wlPath, updated);
    });
}

// ─── Parse Pending (for "이어서 해줘") ───────────────

export function parseWorklogPending(content: string) {
    const lines = content.split('\n');
    const pending = [];
    let inMatrix = false;

    for (const line of lines) {
        if (line.includes('## Agent Status Matrix')) { inMatrix = true; continue; }
        if (inMatrix && line.startsWith('## ')) break;
        if (inMatrix && line.includes('⏳')) {
            const cols = line.split('|').map((c: string) => c.trim()).filter(Boolean);
            if (cols.length >= 3) {
                const phaseMatch = cols[2]!.match(/Phase (\d+)/);
                pending.push({
                    agent: cols[0],
                    role: cols[1],
                    currentPhase: phaseMatch ? +phaseMatch[1]! : 1,  // fallback: 기획부터 재시작
                });
            }
        }
    }

    return pending;
}
