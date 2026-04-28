import {
    countConversationTurns,
    insertPromptIntoComposer,
    submitPromptFromComposer,
    verifyPromptCommitted,
} from './chatgpt-composer.js';

export type PromptInsertStage =
    | 'composer-focus'
    | 'composer-insert'
    | 'composer-verify'
    | 'composer-submit'
    | 'prompt-commit';

export interface PromptCommitBaseline {
    turnsCount?: number;
}

export interface PromptCommitResult {
    turnsCount: number;
}

export interface PromptSubmitResult {
    method: 'button' | 'enter';
}

export interface VendorEditorAdapterOptions {
    insertText?: (text: string) => Promise<void>;
}

export interface VendorEditorAdapter {
    vendor: 'chatgpt';
    waitForReady(): Promise<void>;
    getCommitBaseline(): Promise<PromptCommitBaseline>;
    insertPrompt(text: string): Promise<void>;
    submitPrompt(): Promise<PromptSubmitResult>;
    verifyPromptCommitted(prompt: string, baseline?: PromptCommitBaseline): Promise<PromptCommitResult>;
}

export function createChatGptEditorAdapter(page: any, options: VendorEditorAdapterOptions = {}): VendorEditorAdapter {
    return {
        vendor: 'chatgpt',
        async waitForReady(): Promise<void> {
            await page.locator('#prompt-textarea, .ProseMirror, [contenteditable="true"]').first().waitFor({ state: 'visible', timeout: 10_000 });
        },
        async getCommitBaseline(): Promise<PromptCommitBaseline> {
            return { turnsCount: await countConversationTurns(page) };
        },
        async insertPrompt(text: string): Promise<void> {
            await insertPromptIntoComposer(page, text, options);
        },
        async submitPrompt(): Promise<PromptSubmitResult> {
            return submitPromptFromComposer(page);
        },
        async verifyPromptCommitted(prompt: string, baseline: PromptCommitBaseline = {}): Promise<PromptCommitResult> {
            return verifyPromptCommitted(page, prompt, baseline);
        },
    };
}

export const GEMINI_DEEP_THINK_CONSTRAINTS = {
    inputSelectors: ['rich-textarea .ql-editor', '[role="textbox"][aria-label*="prompt" i]', 'div[contenteditable="true"]'],
    responseSelectors: ['model-response', 'message-content', '.model-response-text message-content'],
    completionSignals: ['.response-footer.complete', '[role="progressbar"]'],
    modeSelectors: [
        'button.toolbox-drawer-button',
        '[role="menuitemcheckbox"]',
        '.toolbox-drawer-item-deselect-button',
        'button[aria-label*="Deselect Deep Think"]',
    ],
} as const;
