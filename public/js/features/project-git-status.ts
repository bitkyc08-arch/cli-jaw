import { api } from '../api.js';

export type ProjectGitSummary =
    | {
        ok: true;
        available: true;
        root: string;
        repoRoot: string;
        branch: string | null;
        head: string | null;
        trackedChangedCount: number;
        untrackedCount: number;
        dirty: boolean;
    }
    | {
        ok: true;
        available: false;
        reason: 'no-project' | 'not-repo' | 'git-unavailable';
    };

function headerGitElement(): HTMLElement | null {
    return document.getElementById('headerGitStatus');
}

function hideHeaderGitStatus(): void {
    const el = headerGitElement();
    if (!el) return;
    el.hidden = true;
    el.textContent = '';
    el.removeAttribute('title');
    el.removeAttribute('aria-label');
}

export function formatProjectGitSummary(summary: ProjectGitSummary | null): { text: string; title: string } | null {
    if (!summary?.available) return null;
    const ref = summary.branch || summary.head;
    if (!ref) return null;
    const parts = ['/', `⑂ ${ref}`];
    if (summary.trackedChangedCount > 0) parts.push(`*${summary.trackedChangedCount}`);
    if (summary.untrackedCount > 0) parts.push(`?${summary.untrackedCount}`);
    const titleParts = [`Git: ${summary.branch ? `branch ${summary.branch}` : `detached ${summary.head}`}`];
    if (summary.trackedChangedCount > 0) titleParts.push(`${summary.trackedChangedCount} tracked changes`);
    if (summary.untrackedCount > 0) titleParts.push(`${summary.untrackedCount} untracked files`);
    return {
        text: parts.join(' '),
        title: titleParts.join(', '),
    };
}

export function renderHeaderGitStatus(summary: ProjectGitSummary | null): void {
    const el = headerGitElement();
    if (!el) return;
    const formatted = formatProjectGitSummary(summary);
    if (!formatted) {
        hideHeaderGitStatus();
        return;
    }
    el.hidden = false;
    el.textContent = formatted.text;
    el.title = formatted.title;
    el.setAttribute('aria-label', formatted.title);
}

export async function loadHeaderGitStatus(): Promise<void> {
    const summary = await api<ProjectGitSummary>('/api/project/git-summary');
    renderHeaderGitStatus(summary);
}

export function refreshHeaderGitStatusFromSettingsChange(msg: { changedKeys?: string[] }): void {
    const changedKeys = Array.isArray(msg.changedKeys) ? msg.changedKeys : [];
    if (!changedKeys.includes('projectDirs')) return;
    void loadHeaderGitStatus();
}
