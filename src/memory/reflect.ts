/**
 * src/memory/reflect.ts — Phase 4: Reflection bank + retain loop
 *
 * Promotes durable facts from daily episodes into stable shared/ pages.
 * Decisions, preferences, project directions, and procedures are extracted
 * and deduplicated before writing.
 */
import fs from 'fs';
import { join } from 'path';
import {
    getAdvancedMemoryDir,
    safeReadFile,
    writeText,
    frontmatter,
    hashText,
    listMarkdownFiles,
} from './shared.js';
import { instanceId } from '../core/instance.js';
import { applySoulUpdate, type SoulSection } from './identity.js';

type ReflectionTarget =
    | 'shared/preferences.md'
    | 'shared/decisions.md'
    | 'shared/projects.md'
    | 'procedures/runbooks.md'
    | 'shared/soul.md';

type RetainFact = {
    text: string;
    target: ReflectionTarget;
    sourceFile: string;
    date: string;
};

export type ReflectionResult = {
    scannedFiles: number;
    extractedFacts: number;
    changedFiles: string[];
    dryRun: boolean;
};

function pickRecentEpisodeFiles(sinceDays: number): string[] {
    const root = getAdvancedMemoryDir();
    const liveDir = join(root, 'episodes', 'live');
    if (!fs.existsSync(liveDir)) return [];

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - sinceDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    return listMarkdownFiles(liveDir).filter(f => {
        const name = f.split('/').pop() || '';
        const dateMatch = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(name);
        return dateMatch && dateMatch[1]! >= cutoffStr;
    }).sort();
}

function classifyLine(line: string): ReflectionTarget | null {
    const lower = line.toLowerCase();
    if (/\bprefer|preference|설정|선호|config|default\b/.test(lower)) return 'shared/preferences.md';
    if (/\bdecid|decision|결정|chose|선택|policy|approach\b/.test(lower)) return 'shared/decisions.md';
    if (/\bproject|프로젝트|repo|deploy|release|roadmap\b/.test(lower)) return 'shared/projects.md';
    if (/\brunbook|procedure|step|workflow|how.to|절차|방법\b/.test(lower)) return 'procedures/runbooks.md';
    return null;
}

const IDENTITY_KEYWORDS = /\b(always|never|prefer|tone|style|value|principle|boundary|relationship|trust)\b/i;

function isIdentityRelevant(text: string): boolean {
    return IDENTITY_KEYWORDS.test(text);
}

function classifyIdentitySection(text: string): SoulSection {
    const lower = text.toLowerCase();
    if (/never|boundary|forbidden|prohibit/.test(lower)) return 'Boundaries';
    if (/tone|style|concise|verbose|friendly/.test(lower)) return 'Tone';
    if (/value|principle|priority|accuracy/.test(lower)) return 'Core Values';
    if (/relationship|partner|trust|collaborate/.test(lower)) return 'Relationship';
    return 'Defaults';
}

function extractRetainFacts(files: string[]): RetainFact[] {
    const facts: RetainFact[] = [];

    for (const file of files) {
        const content = safeReadFile(file);
        const name = file.split('/').pop() || '';
        const dateMatch = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(name);
        const date = dateMatch?.[1] || new Date().toISOString().slice(0, 10);

        const lines = content.split('\n');
        for (const line of lines) {
            const trimmed = line
                .replace(/^[-*•]\s*/, '')
                .replace(/^\*\*\d{2}:\d{2}\*\*\s*/, '')
                .trim();
            if (!trimmed || trimmed.length < 15) continue;
            if (/^(---|#|Source:|Kind:|Header:)/.test(trimmed)) continue;

            const target = classifyLine(trimmed);
            if (target) {
                facts.push({ text: trimmed, target, sourceFile: file, date });
            } else if (isIdentityRelevant(trimmed)) {
                facts.push({ text: trimmed, target: 'shared/soul.md', sourceFile: file, date });
            }
        }
    }

    // Deduplicate by text similarity (exact prefix match)
    const seen = new Set<string>();
    return facts.filter(f => {
        const key = f.text.toLowerCase().slice(0, 80);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).slice(0, 20); // Cap at 20 facts per reflection
}

function groupFactsByTarget(facts: RetainFact[]): Map<ReflectionTarget, RetainFact[]> {
    const grouped = new Map<ReflectionTarget, RetainFact[]>();
    for (const fact of facts) {
        const list = grouped.get(fact.target) || [];
        list.push(fact);
        grouped.set(fact.target, list);
    }
    return grouped;
}

function writeReflectionTargets(
    grouped: Map<ReflectionTarget, RetainFact[]>,
    opts: { dryRun: boolean },
): ReflectionResult {
    const root = getAdvancedMemoryDir();
    const changedFiles: string[] = [];
    let extractedFacts = 0;

    for (const [target, facts] of grouped) {
        const filePath = join(root, target);
        extractedFacts += facts.length;

        if (opts.dryRun) continue;

        // Soul target: route through identity gate instead of direct write
        if (target === 'shared/soul.md') {
            for (const fact of facts) {
                applySoulUpdate({
                    section: classifyIdentitySection(fact.text),
                    action: 'add',
                    content: fact.text,
                    reason: `reflection:${fact.sourceFile}`,
                    confidence: 'medium',
                });
            }
            continue;
        }

        const existing = fs.existsSync(filePath) ? safeReadFile(filePath) : '';
        const existingLower = existing.toLowerCase();

        // Filter out facts already present in the target file
        const newFacts = facts.filter(
            f => !existingLower.includes(f.text.toLowerCase().slice(0, 60)),
        );
        if (!newFacts.length) continue;

        const dateHeader = newFacts[0]!.date;
        const bullets = newFacts.map(f => `- ${f.text}`).join('\n');
        const section = `\n## ${dateHeader}\n\n${bullets}\n`;

        if (existing) {
            // Update frontmatter updated_at if present
            const updatedContent = existing.replace(
                /^(updated_at:\s+).+$/m,
                `$1${new Date().toISOString()}`,
            );
            if (updatedContent !== existing) {
                fs.writeFileSync(filePath, updatedContent);
            }
            fs.appendFileSync(filePath, section);
        } else {
            const title = target.split('/').pop()?.replace('.md', '') || 'reflected';
            const fm = frontmatter({
                id: `reflect-${hashText(target + dateHeader)}`,
                home_id: instanceId(),
                kind: target.startsWith('procedures/') ? 'procedure' : 'shared',
                source: 'reflection',
                trust_level: 'high',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            });
            writeText(filePath, fm + `# ${title.charAt(0).toUpperCase() + title.slice(1)}\n${section}`);
        }

        changedFiles.push(filePath);
    }

    return {
        scannedFiles: 0, // Set by caller
        extractedFacts,
        changedFiles,
        dryRun: opts.dryRun,
    };
}

export function reflectRecentEpisodes(options?: { sinceDays?: number; dryRun?: boolean }): ReflectionResult {
    const recentFiles = pickRecentEpisodeFiles(options?.sinceDays ?? 7);
    const retained = extractRetainFacts(recentFiles);
    const grouped = groupFactsByTarget(retained);
    const result = writeReflectionTargets(grouped, { dryRun: options?.dryRun === true });
    result.scannedFiles = recentFiles.length;
    return result;
}

function getLastReflectedAtLocal(): string | null {
    const metaPath = join(getAdvancedMemoryDir(), '.reflect-meta.json');
    try {
        const raw = safeReadFile(metaPath);
        if (!raw) return null;
        const meta = JSON.parse(raw);
        return meta.lastReflectedAt || null;
    } catch { return null; }
}

export async function maybeAutoReflect(): Promise<boolean> {
    const lastReflect = getLastReflectedAtLocal();
    const hoursSince = lastReflect
        ? (Date.now() - new Date(lastReflect).getTime()) / 3600000
        : Infinity;
    if (hoursSince < 24) return false;
    reflectRecentEpisodes();
    return true;
}

export function cleanupStaleEpisodes(opts: { retentionDays?: number } = {}): number {
    const retention = opts.retentionDays ?? 90;
    const cutoff = Date.now() - retention * 86400000;
    const episodesDir = join(getAdvancedMemoryDir(), 'episodes');
    const archiveDir = join(getAdvancedMemoryDir(), 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });

    let moved = 0;
    if (!fs.existsSync(episodesDir)) return 0;
    const files = listMarkdownFiles(episodesDir);
    for (const filePath of files) {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
            const relName = filePath.slice(episodesDir.length + 1);
            const destPath = join(archiveDir, relName);
            fs.mkdirSync(join(destPath, '..'), { recursive: true });
            fs.renameSync(filePath, destPath);
            moved++;
        }
    }
    if (moved > 0) console.log(`[memory] archived ${moved} stale episodes`);
    return moved;
}
