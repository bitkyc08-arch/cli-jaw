/**
 * src/memory/injection.ts — Phase 3: Centralized memory injection policy
 *
 * Single source of truth for memory injection scoping.
 * Role-based: boss (full), employee (profile only), flush (none).
 */
import { getAdvancedMemoryStatus, loadAdvancedProfileSummary, loadSoulSummary, buildTaskSnapshot, searchAdvancedMemory } from './runtime.js';
import * as memory from './memory.js';

export type MemoryInjectionRole = 'boss' | 'employee' | 'subagent' | 'flush' | 'read_only_tool';

type BuildMemoryInjectionOptions = {
    role: MemoryInjectionRole;
    currentPrompt: string;
    providedSnapshot?: string;
    allowProfile?: boolean;
    allowSnapshot?: boolean;
};

export function buildMemoryInjection(opts: BuildMemoryInjectionOptions) {
    const status = getAdvancedMemoryStatus();
    if (status.routing?.searchRead !== 'advanced') {
        return { mode: 'legacy' as const, profile: '', snapshot: '', text: '' };
    }

    const includeProfile = opts.allowProfile !== false && opts.role !== 'flush';
    const includeSnapshot = opts.allowSnapshot !== false && opts.role === 'boss';
    const includeSoul = opts.role === 'boss';
    const profile = includeProfile ? loadAdvancedProfileSummary(800) : '';
    const soul = includeSoul ? loadSoulSummary(1000) : '';
    const snapshot = includeSnapshot
        ? (opts.providedSnapshot !== undefined && opts.providedSnapshot !== ''
            ? opts.providedSnapshot
            : buildTaskSnapshot(opts.currentPrompt, 2800))
        : '';

    return {
        mode: 'advanced' as const,
        profile,
        soul,
        snapshot,
        text: renderMemoryInjectionBlock({ role: opts.role, profile, soul, snapshot }),
    };
}

function renderMemoryInjectionBlock(opts: { role: MemoryInjectionRole; profile: string; soul?: string; snapshot: string }) {
    const parts: string[] = ['---', '## Memory Runtime'];
    parts.push('- indexed memory context is active');
    parts.push(`- injection role: ${opts.role}`);
    parts.push('- use task snapshot and profile context before assuming missing memory');
    if (opts.profile) {
        parts.push('', '## Profile Context', opts.profile);
    }
    if (opts.soul) {
        parts.push('', '## Soul & Identity', opts.soul);
    }
    if (opts.snapshot) {
        parts.push('', opts.snapshot);
    }
    return parts.join('\n');
}

export function searchMemoryWithPolicy(opts: { query: string; role: MemoryInjectionRole }) {
    const status = getAdvancedMemoryStatus();
    if (status.enabled && status.routing?.searchRead === 'advanced') {
        return searchAdvancedMemory(opts.query);
    }
    return memory.search(opts.query);
}
