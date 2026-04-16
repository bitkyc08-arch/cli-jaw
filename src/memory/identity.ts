/**
 * src/memory/identity.ts — SOUL identity ledger management
 *
 * Reads, updates, and gates writes to shared/soul.md.
 * SOUL updates are conservative: only durable, repeated patterns are promoted.
 */
import fs from 'fs';
import { join } from 'path';
import { getAdvancedMemoryDir } from './shared.js';
import { reindexIntegratedMemoryFile } from './indexing.js';

const SOUL_RELPATH = join('shared', 'soul.md');

export type SoulSection = 'Core Values' | 'Tone' | 'Boundaries' | 'Relationship' | 'Defaults';

export type SoulUpdate = {
    section: SoulSection;
    action: 'add' | 'remove' | 'replace';
    content: string;
    reason: string;
    confidence: 'high' | 'medium';
};

export type SoulUpdateResult = { applied: boolean; reason: string };

export function getSoulPath(): string {
    return join(getAdvancedMemoryDir(), SOUL_RELPATH);
}

export function readSoul(): string {
    const p = getSoulPath();
    if (!fs.existsSync(p)) return '';
    return fs.readFileSync(p, 'utf8');
}

/**
 * Apply a gated update to SOUL.
 * Only high-confidence updates are auto-applied.
 * Medium-confidence updates are logged but require manual approval.
 */
export function applySoulUpdate(update: SoulUpdate): SoulUpdateResult {
    if (update.confidence === 'medium') {
        console.log(`[identity] medium-confidence soul update logged: ${update.content.slice(0, 80)}`);
        const candidatesPath = join(getAdvancedMemoryDir(), 'shared', 'soul-candidates.log');
        const entry = `[${new Date().toISOString()}] (${update.section}) ${update.content}\n`;
        fs.appendFileSync(candidatesPath, entry);
        return { applied: false, reason: 'medium confidence — logged for review' };
    }

    const soul = readSoul();
    if (!soul) return { applied: false, reason: 'soul.md not found' };

    const sectionHeader = `## ${update.section}`;
    const idx = soul.indexOf(sectionHeader);
    if (idx === -1) return { applied: false, reason: `section not found: ${update.section}` };

    const afterHeader = idx + sectionHeader.length;
    const nextSection = soul.indexOf('\n## ', afterHeader);
    const sectionEnd = nextSection === -1 ? soul.length : nextSection;
    const sectionContent = soul.slice(afterHeader, sectionEnd);

    if (update.action === 'add' && sectionContent.includes(update.content.trim())) {
        return { applied: false, reason: 'already exists in soul' };
    }

    let newSoul: string;
    if (update.action === 'replace') {
        const newContent = `\n${update.content.trim()}\n`;
        newSoul = soul.slice(0, afterHeader) + newContent + soul.slice(sectionEnd);
    } else if (update.action === 'add') {
        const insertion = `\n- ${update.content.trim()}`;
        newSoul = soul.slice(0, sectionEnd) + insertion + soul.slice(sectionEnd);
    } else {
        const lines = sectionContent.split('\n');
        const filtered = lines.filter(l => !l.includes(update.content.trim()));
        newSoul = soul.slice(0, afterHeader) + filtered.join('\n') + soul.slice(sectionEnd);
    }

    newSoul = newSoul.replace(/updated_at: .+/, `updated_at: ${new Date().toISOString()}`);
    fs.writeFileSync(getSoulPath(), newSoul);
    console.log(`[identity] soul updated (${update.action}): ${update.content.slice(0, 80)}`);

    try { reindexIntegratedMemoryFile(getSoulPath()); } catch { /* best effort */ }

    return { applied: true, reason: 'ok' };
}
