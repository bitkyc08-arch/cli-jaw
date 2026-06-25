import { getActivePage } from '../connection.js';
import { buildCodeModePrompt, checkContractCompliance } from './code-mode-prompt.js';
import { ensureCodeDevContextZip } from './code-dev-context.js';
import { retrieveAllCodeArtifacts, retrieveCodeArtifact, type PageLike } from './code-artifact.js';
import { WebAiError } from './errors.js';
import { getSession } from './session.js';
import { query } from './chatgpt.js';
import type { QuestionEnvelopeInput } from './types.js';

const CONVERSATION_ID_RE = /\/c\/([a-z0-9-]+)/i;
const BARE_CONVERSATION_ID_RE = /^[a-z0-9][a-z0-9-]{8,}$/i;

type CodeQueryResult = Record<string, unknown> & {
    ok?: boolean;
    warnings?: string[];
    answerText?: string;
    sessionId?: string;
    compliance?: { compliant: boolean; mentionsPath: boolean };
};

export function extractConversationId(url: string | null | undefined): string | null {
    const match = String(url || '').match(CONVERSATION_ID_RE);
    if (match) return match[1] || null;
    const value = String(url || '').trim();
    return BARE_CONVERSATION_ID_RE.test(value) ? value : null;
}

/** 104.10: the canonical conversation URL to extract from (a full chatgpt URL, else built from id). */
export function resolveConversationUrl(conversationRef: string | null | undefined, conversationId: string): string {
    const value = String(conversationRef || '').trim();
    if (/^https:\/\/chatgpt\.com\/c\//i.test(value)) return value;
    return `https://chatgpt.com/c/${conversationId}`;
}

/** 104.10: navigate before extraction when the active tab is a different origin or conversation. */
export function shouldNavigateForExtraction(pageUrl: string | null | undefined, targetUrl: string): boolean {
    if (!pageUrl) return true;
    try {
        const current = new URL(pageUrl);
        const target = new URL(targetUrl);
        if (current.origin !== target.origin) return true;
        return extractConversationId(current.href) !== extractConversationId(target.href);
    } catch {
        return true;
    }
}

export async function codeWebAi(port: number, input: QuestionEnvelopeInput & { conversation?: string; session?: string; outputZip?: string; outputDir?: string; multiZip?: boolean; contextRefresh?: boolean; timeout?: string | number } = {}): Promise<Record<string, unknown>> {
    if (input.vendor && input.vendor !== 'chatgpt') {
        throw new WebAiError({ errorCode: 'code-mode.vendor-unsupported', stage: 'code-mode', retryHint: 'use-chatgpt', message: 'web-ai code is ChatGPT-only (container tool contract)' });
    }
    // Continuation turns (existing conversation via url/conversation, or a resumed
    // recorded session) reuse the same ChatGPT container: the dev-agent context zip
    // from the first turn is already in /mnt/data and its contract lives in the
    // conversation history — skip the re-upload unless contextRefresh forces it.
    const continuation = Boolean(extractConversationId(input.conversation || input.url) || input.session);
    const attachContext = !continuation || input.contextRefresh === true;
    const contextZip = attachContext ? await ensureCodeDevContextZip() : null;
    const callerFilePaths = Array.isArray(input.filePaths) && input.filePaths.length ? input.filePaths : (input.filePath ? [input.filePath] : []);
    const filePaths = [...(contextZip ? [contextZip.path] : []), ...callerFilePaths];
    const queryInput = {
        ...input,
        prompt: buildCodeModePrompt(String(input.prompt || ''), { multiZip: input.multiZip === true }),
        inlineOnly: false,
        attachmentPolicy: filePaths.length ? 'upload' : 'inline-only',
        filePaths,
        ...(filePaths[0] ? { filePath: filePaths[0] } : {}),
    };
    const result = await query(port, queryInput) as unknown as CodeQueryResult;
    if (!result?.ok) return result;
    const warnings = [...(result.warnings || [])];
    if (input.multiZip !== true) {
        const compliance = checkContractCompliance(String(result.answerText || ''));
        if (!compliance.compliant) warnings.push('code-mode:contract-drift');
        if (!compliance.mentionsPath) warnings.push('code-mode:answer-missing-artifact-path');
        result.compliance = compliance;
    }
    const session = result.sessionId ? getSession(String(result.sessionId)) : null;
    const page = await getActivePage(port);
    const pageUrl = typeof page?.url === 'function' ? page.url() : '';
    const conversationId = extractConversationId(session?.conversationUrl)
        || extractConversationId(session?.url)
        || extractConversationId(pageUrl);
    if (!conversationId) return { ...result, ok: false, errorCode: 'code-mode.conversation-id-missing', warnings, codeContextZip: contextZip?.path ?? null, codeContextAttached: attachContext };
    if (input.multiZip === true) {
        const outputDir = input.outputDir || `${process.cwd()}/code-artifacts-${conversationId.slice(0, 8)}`;
        const multi = await retrieveAllCodeArtifacts(page as unknown as PageLike, { conversationId, outputDir, requirePlan: true });
        if (!multi.ok) return { ...result, ok: false, errorCode: multi.reason || 'code-mode.retrieval-failed', artifacts: multi.artifacts, warnings, codeContextZip: contextZip?.path ?? null, codeContextAttached: attachContext };
        return { ...result, ok: true, artifacts: multi.artifacts, outputDir, warnings, codeContextZip: contextZip?.path ?? null, codeContextAttached: attachContext };
    }
    const outputPath = input.outputZip || `${process.cwd()}/code-artifact-${conversationId.slice(0, 8)}.zip`;
    const artifact = await retrieveCodeArtifact(page as unknown as PageLike, { conversationId, outputPath, requirePlan: true });
    if (!artifact.ok) return { ...result, ok: false, errorCode: artifact.reason || 'code-mode.retrieval-failed', artifact, warnings, codeContextZip: contextZip?.path ?? null, codeContextAttached: attachContext };
    return { ...result, ok: true, artifact, warnings, codeContextZip: contextZip?.path ?? null, codeContextAttached: attachContext };
}

export async function extractCodeArtifacts(port: number, input: { vendor?: string; url?: string; conversation?: string; session?: string; outputZip?: string; outputDir?: string; multiZip?: boolean } = {}): Promise<Record<string, unknown>> {
    if (input.vendor && input.vendor !== 'chatgpt') {
        throw new WebAiError({ errorCode: 'code-mode.vendor-unsupported', stage: 'code-extract', retryHint: 'use-chatgpt', message: 'web-ai code-extract is ChatGPT-only (container artifact contract)' });
    }
    const session = input.session ? getSession(input.session) : null;
    const page = await getActivePage(port);
    const pageUrl = typeof page?.url === 'function' ? page.url() : '';
    const conversationRef = input.conversation || input.url || session?.conversationUrl || session?.url || pageUrl;
    const conversationId = extractConversationId(conversationRef);
    if (!conversationId) return { ok: false, status: 'error', errorCode: 'code-extract.conversation-id-missing', warnings: [] };
    // 104.10: navigate to the target conversation before extracting, so we read the RIGHT
    // conversation (not whatever the active tab currently shows).
    const targetUrl = resolveConversationUrl(conversationRef, conversationId);
    if (page && shouldNavigateForExtraction(pageUrl, targetUrl)) {
        try {
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        } catch (err) {
            return { ok: false, status: 'error', errorCode: 'code-extract.navigation-failed', conversationId, warnings: [(err as Error)?.message || 'navigation failed'] };
        }
    }
    if (input.multiZip === true) {
        const outputDir = input.outputDir || `${process.cwd()}/code-artifacts-${conversationId.slice(0, 8)}`;
        const multi = await retrieveAllCodeArtifacts(page as unknown as PageLike, { conversationId, outputDir, requirePlan: false });
        return { ok: multi.ok, status: multi.ok ? 'complete' : 'error', errorCode: multi.ok ? undefined : (multi.reason || 'code-extract.retrieval-failed'), conversationId, artifacts: multi.artifacts, outputDir, warnings: [] };
    }
    const outputPath = input.outputZip || `${process.cwd()}/code-artifact-${conversationId.slice(0, 8)}.zip`;
    const artifact = await retrieveCodeArtifact(page as unknown as PageLike, { conversationId, outputPath, requirePlan: false });
    return { ok: artifact.ok, status: artifact.ok ? 'complete' : 'error', errorCode: artifact.ok ? undefined : (artifact.reason || 'code-extract.retrieval-failed'), conversationId, artifact, warnings: [] };
}
