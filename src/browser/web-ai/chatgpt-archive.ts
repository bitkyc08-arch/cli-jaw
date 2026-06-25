// Parity catalog 102 (chatgpt-archive). Strict-TS port of agbrowse web-ai/chatgpt-archive.mjs.
// Auto-archive hygiene for one-shot ChatGPT conversations: resolveArchivePolicy decides
// whether to archive (never for temporary/multi-turn/deep-research/project/incomplete
// chats, or when an artifact save was required and failed); archiveConversation drives
// the conversation-menu → Archive UI. Pure policy helpers are fully unit-testable.

export interface ArchivePolicyResult {
    shouldArchive: boolean;
    reason: string;
}

export interface ArchivePolicySession {
    conversationUrl?: string | null;
    originalUrl?: string | null;
    followUpCount?: number;
    researchMode?: string | null;
    projectUrl?: string | null;
    status?: string;
}

export interface ArchiveArtifactStatus {
    required?: boolean;
    ok?: boolean;
    stage?: string;
    error?: string;
}

/** Resolve archive policy based on the --archive flag and session/artifact state. */
export function resolveArchivePolicy({
    archiveFlag = 'auto',
    session,
    artifactStatus = null,
}: {
    archiveFlag?: string;
    session: ArchivePolicySession;
    artifactStatus?: ArchiveArtifactStatus | null;
}): ArchivePolicyResult {
    if (archiveFlag === 'never') {
        return { shouldArchive: false, reason: 'archive-disabled' };
    }

    const conversationUrl = session?.conversationUrl;
    if (!conversationUrl) {
        return { shouldArchive: false, reason: 'no-conversation-url' };
    }

    if (isTemporaryChatgptUrl(session?.originalUrl) || isTemporaryChatgptUrl(conversationUrl)) {
        return { shouldArchive: false, reason: 'temporary-chat' };
    }

    if (artifactStatus?.required === true && artifactStatus.ok === false) {
        return { shouldArchive: false, reason: 'artifact-save-failed' };
    }

    if (archiveFlag === 'always') {
        return { shouldArchive: true, reason: 'archive-forced' };
    }

    if ((session.followUpCount ?? 0) > 0) {
        return { shouldArchive: false, reason: 'multi-turn-session' };
    }
    if (session.researchMode === 'deep') {
        return { shouldArchive: false, reason: 'deep-research-session' };
    }
    if (session.projectUrl) {
        return { shouldArchive: false, reason: 'project-chat' };
    }
    if (session.status !== 'complete' && session.status !== 'completed') {
        return { shouldArchive: false, reason: 'session-not-completed' };
    }

    return { shouldArchive: true, reason: 'auto-archive-one-shot' };
}

export function isTemporaryChatgptUrl(url: unknown): boolean {
    if (!url) return false;
    try {
        const parsed = new URL(String(url));
        return parsed.searchParams.get('temporary-chat')?.trim().toLowerCase() === 'true';
    } catch {
        return false;
    }
}

const ARCHIVE_MENU_SELECTORS = [
    'button[data-testid="conversation-menu-trigger"]',
    'button[aria-label*="Options" i]',
    'button[aria-haspopup="menu"]',
];

const ARCHIVE_ITEM_SELECTORS = [
    '[role="menuitem"]:has-text("Archive")',
    'div[role="menuitem"]:has-text("Archive")',
    'a:has-text("Archive chat")',
];

interface ArchiveLocatorHandle {
    isVisible(): Promise<boolean>;
    click(): Promise<void>;
}

export interface ArchivePage {
    url(): string;
    locator(selector: string): { first(): ArchiveLocatorHandle };
    waitForTimeout(timeout: number): Promise<void>;
    keyboard: { press(key: string): Promise<void> };
}

/** Archive a ChatGPT conversation via the UI. Best-effort; returns a warning on miss. */
export async function archiveConversation(
    page: ArchivePage,
    { conversationUrl }: { conversationUrl: string },
): Promise<{ ok: boolean; warning?: string }> {
    const currentUrl = page.url();
    if (!currentUrl.includes(extractConversationId(conversationUrl) || '__never__')) {
        return { ok: false, warning: 'conversation-url-mismatch' };
    }

    for (const sel of ARCHIVE_MENU_SELECTORS) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible().catch(() => false)) {
            await btn.click();
            await page.waitForTimeout(500);

            for (const itemSel of ARCHIVE_ITEM_SELECTORS) {
                const item = page.locator(itemSel).first();
                if (await item.isVisible().catch(() => false)) {
                    await item.click();
                    await page.waitForTimeout(1000);
                    return { ok: true };
                }
            }
            await page.keyboard.press('Escape');
            return { ok: false, warning: 'archive-menu-item-not-found' };
        }
    }

    return { ok: false, warning: 'archive-menu-trigger-not-found' };
}

function extractConversationId(url: string): string | null {
    if (!url) return null;
    const match = url.match(/\/c\/([a-f0-9-]+)/);
    return match ? match[1]! : null;
}
