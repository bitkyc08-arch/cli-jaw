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
import { reindexIntegratedMemoryFile } from './indexing.js';
import { log } from '../core/logger.js';

type ReflectionTarget =
    | 'profile.md'
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

function isLikelyNonClassifiable(line: string): boolean {
    const lower = line.toLowerCase().trim();
    if (/^(what|how|why|when|where|do you|can you|could you|should we|어떻게|왜|언제)\b/.test(lower)) return true;
    if (/\b(not|never|don't|doesn't|아니|안 |없이)\b/.test(lower) && lower.length < 50) return true;
    return false;
}

function scoreMatches(line: string, patterns: RegExp[]): number {
    return patterns.filter(p => p.test(line)).length;
}

function isImperativeProcedure(line: string): boolean {
    const lower = line.toLowerCase().trim();
    if (/^(run|execute|create|build|deploy|setup|install|configure|start|stop|restart)\b/.test(lower)) return true;
    if (/(하세요|해라|하시오|실행|시작|중지|배포|설치)$/.test(lower)) return true;
    return false;
}

function hasListPattern(line: string): boolean {
    return /^\s*[-*•]\s|^\s*\d+\.\s/.test(line);
}

function classifyLine(line: string): ReflectionTarget | null {
    const lower = line.toLowerCase();

    if (isLikelyNonClassifiable(line)) return null;

    if (/(?:^|\s)(my role|i'm a|i am a|내 역할|내 직무|i work as|uses? macos|uses? linux|node v\d|m\d (max|pro)|developer|engineer|admin|작업 환경|개발 환경)(?:\s|$)/i.test(lower)) {
        return 'profile.md';
    }

    const scores = {
        runbooks: scoreMatches(lower, [
            /\brunbook|procedure|절차/,
            /\bstep [0-9]|단계 \d/,
            /\bworkflow|how.to|방법/,
        ]),
        preferences: scoreMatches(lower, [
            /\bprefer|preference|선호|취향/,
            /\bconfig|setting|설정|환경설정/,
            /\bdefault|기본값|디폴트/,
        ]),
        decisions: scoreMatches(lower, [
            /\bdecid|decision|결정/,
            /\bchose|choose|선택/,
            /\bpolicy|approach|방침/,
        ]),
        projects: scoreMatches(lower, [
            /\bproject|프로젝트/,
            /\brepo|deploy|release|배포/,
            /\broadmap|milestone|마일스톤/,
        ]),
    };

    if (scores.runbooks >= 2 && (isImperativeProcedure(line) || hasListPattern(line))) {
        return 'procedures/runbooks.md';
    }
    if (scores.preferences >= 1) return 'shared/preferences.md';
    if (scores.decisions >= 1) return 'shared/decisions.md';
    if (scores.projects >= 1) return 'shared/projects.md';

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
    const deduped = facts.filter(f => {
        const key = f.text.toLowerCase().slice(0, 80);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    const PER_TARGET_CAP = 6;
    const byTarget = new Map<string, RetainFact[]>();
    for (const fact of deduped) {
        const list = byTarget.get(fact.target) || [];
        if (list.length < PER_TARGET_CAP) list.push(fact);
        byTarget.set(fact.target, list);
    }
    return [...byTarget.values()].flat().slice(0, 24);
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

        // Profile target: section-based upsert
        if (target === 'profile.md') {
            const existing = fs.existsSync(filePath) ? safeReadFile(filePath) : '';
            const existingLower = existing.toLowerCase();

            const newFacts = facts.filter(
                f => !existingLower.includes(f.text.toLowerCase().slice(0, 60)),
            );
            if (!newFacts.length) continue;

            const sectionBuckets: Record<string, string[]> = {
                'User Preferences': [],
                'Key Decisions': [],
                'Active Projects': [],
            };
            for (const fact of newFacts) {
                const fl = fact.text.toLowerCase();
                if (/decid|chose|선택|결정|policy|approach/.test(fl)) {
                    sectionBuckets['Key Decisions']!.push(`- ${fact.text}`);
                } else if (/project|프로젝트|repo|deploy|release/.test(fl)) {
                    sectionBuckets['Active Projects']!.push(`- ${fact.text}`);
                } else {
                    sectionBuckets['User Preferences']!.push(`- ${fact.text}`);
                }
            }

            let content = existing;
            for (const [heading, bullets] of Object.entries(sectionBuckets)) {
                if (!bullets.length) continue;
                const sectionRe = new RegExp(`(## ${heading}\\n)`, 'm');
                if (sectionRe.test(content)) {
                    content = content.replace(sectionRe, `$1${bullets.join('\n')}\n`);
                } else {
                    content += `\n## ${heading}\n${bullets.join('\n')}\n`;
                }
            }

            if (content !== existing) {
                fs.writeFileSync(filePath, content);
                changedFiles.push(filePath);
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

    const result = reflectRecentEpisodes();

    for (const changed of result.changedFiles) {
        reindexIntegratedMemoryFile(changed);
    }

    if (result.changedFiles.length > 0) {
        const metaPath = join(getAdvancedMemoryDir(), '.reflect-meta.json');
        fs.writeFileSync(metaPath, JSON.stringify({
            lastReflectedAt: new Date().toISOString(),
        }));
    }

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
    if (moved > 0) log.info(`[memory] archived ${moved} stale episodes`);
    return moved;
}
