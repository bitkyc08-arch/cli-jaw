// ─── Research Employee Dispatch Helper ──────────────
// Phase-independent research dispatch for the Research employee.
// Callable from IDLE, P, A, B, C — always read-only, report-only.

import { broadcast } from '../core/bus.js';
import { getEmployees, upsertEmployeeSession } from '../core/db.js';
import { getEmployeePromptV2 } from '../prompt/builder.js';
import { spawnAgent } from '../agent/spawn.js';
import { findEmployee } from './distribute.js';

// ─── Types ──────────────────────────────────────────

export interface ResearchReport {
  rawText: string;
  summary: string;
  options: string[];
  unknowns: string[];
}

type SpawnAgentLike = typeof spawnAgent;

// ─── Ambiguity Detection ────────────────────────────

const AMBIGUOUS_SIGNALS = [
  /정리해\s*줘/i, /구조\s*잡아/i, /개선해\s*줘/i,
  /어떻게\s*(하면|해야|할까)/i, /뭐가\s*(좋|나을|맞)/i,
  /비교해\s*줘/i, /조사해\s*줘/i, /알아봐\s*줘/i,
  /분석해\s*줘/i, /리서치/i,
  /investigate/i, /compare/i, /research/i,
  /what('?s| is) the best/i, /how should/i,
  /explore\s+(the|this)/i, /look into/i,
  /figure out/i, /find out/i,
];

export function isAmbiguousRequest(text: string): boolean {
  const t = (text || '').trim();
  if (!t || t.length < 3) return false;
  return AMBIGUOUS_SIGNALS.some(re => re.test(t));
}

export function shouldRunResearch(text: string, meta: Record<string, any> = {}): boolean {
  if (meta._workerResult || meta._skipResearch || meta._researchInjected) return false;
  return isAmbiguousRequest(text);
}

// ─── Research Dispatch ──────────────────────────────

export async function dispatchResearchTask(
  task: string,
  meta: Record<string, any> = {},
): Promise<ResearchReport> {
  const emps = getEmployees.all() as Record<string, any>[];
  const configuredEmp = findEmployee(emps, { agent: 'Research' });
  const injectedEmp = meta._employee;
  const emp = injectedEmp === undefined
    ? (configuredEmp || buildFallbackResearchEmployee())
    : (injectedEmp || buildFallbackResearchEmployee());
  const runSpawnAgent: SpawnAgentLike = typeof meta._spawnAgent === 'function'
    ? meta._spawnAgent
    : spawnAgent;

  if (!configuredEmp) {
    console.warn('[jaw:research] Research employee not found, using fallback Research employee');
  }

  const sysPrompt = getEmployeePromptV2(emp, 'research', 1);

  // Force fresh session to avoid context contamination
  upsertEmployeeSession.run(emp.id, null, emp.cli);

  broadcast('agent_status', {
    agentId: emp.id, agentName: emp.name,
    status: 'running', phase: 1, phaseLabel: 'Research',
    isEmployee: true,
  });

  const researchPrompt = `## Research Task
${task}

## Output Format (REQUIRED)
Respond with this exact structure:

## Research Report
### Context
(Background information gathered from codebase, memory, worklog, or external sources)

### Options
(Numbered list of possible approaches or answers)

### Recommendation
(Your recommended approach with reasoning)

### Unknowns
(Things you could not determine — list as bullet points)

⛔ RULES:
- Do NOT create, modify, or delete any files
- Do NOT write implementation code
- Only read, search, and report`;

  const { promise } = runSpawnAgent(researchPrompt, {
    agentId: emp.id,
    cli: emp.cli,
    model: emp.model,
    forceNew: true,
    sysPrompt,
    origin: meta.origin || 'web',
  });

  const r = await promise as Record<string, any>;

  if (r.code === 0 && r.sessionId) {
    upsertEmployeeSession.run(emp.id, r.sessionId, emp.cli);
  }

  broadcast('agent_status', {
    agentId: emp.id, agentName: emp.name,
    status: r.code === 0 ? 'done' : 'error', phase: 1,
    isEmployee: true,
  });

  const parsed = parseResearchReport(r.text || '');
  if (parsed.rawText) return parsed;

  const failureReason = r.code === 127
    ? 'Research employee CLI not available'
    : `Research employee failed with code ${r.code ?? 'unknown'}`;
  return {
    rawText: '',
    summary: '',
    options: [],
    unknowns: [...parsed.unknowns, failureReason],
  };
}

// ─── Report Parsing ─────────────────────────────────

export function parseResearchReport(text: string): ResearchReport {
  const summary = extractSection(text, 'Context') || extractSection(text, 'Recommendation') || '';
  const optionsRaw = extractSection(text, 'Options') || '';
  const unknownsRaw = extractSection(text, 'Unknowns') || '';

  return {
    rawText: text,
    summary: summary.trim(),
    options: extractListItems(optionsRaw),
    unknowns: extractListItems(unknownsRaw),
  };
}

function buildFallbackResearchEmployee() {
  return {
    id: 'research-fallback',
    name: 'Research',
    cli: 'claude',
    model: 'claude-haiku-4-5-20251001',
    role: 'Search, codebase exploration, uncertainty reduction, read-only reports',
  };
}

function extractSection(text: string, heading: string): string {
  const re = new RegExp(`###\\s*${heading}\\s*\\n([\\s\\S]*?)(?=###|$)`, 'i');
  const m = text.match(re);
  return m?.[1]?.trim() || '';
}

function extractListItems(text: string): string[] {
  return text
    .split('\n')
    .map(l => l.replace(/^[-*\d.)\s]+/, '').trim())
    .filter(Boolean);
}

// ─── Prompt Injection ───────────────────────────────

export function injectResearchIntoPlanningPrompt(
  planPrompt: string,
  report: ResearchReport,
): string {
  if (!report.rawText) return planPrompt;
  const injection = `## Pre-Planning Research Report
The following research was conducted before planning. Use this as context.

${report.rawText}

---
`;
  return injection + planPrompt;
}
