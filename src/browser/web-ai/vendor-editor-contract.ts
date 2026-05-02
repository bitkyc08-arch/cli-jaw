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
        'button[aria-label="New chat"]:not([aria-disabled="true"]):not(.disabled)',
        'button.toolbox-drawer-button',
        '[role="menuitemcheckbox"]:has-text("Deep think")',
        'button[aria-label*="Deselect Deep think"]',
    ],
} as const;

import { CHATGPT_COPY_SELECTORS, GEMINI_COPY_SELECTORS, GROK_COPY_SELECTORS } from './copy-markdown.js';
import { CHATGPT_MODEL_SELECTOR_BUTTONS } from './chatgpt-model.js';

export const CHATGPT_COMPOSER_SELECTORS = ['#prompt-textarea', '[data-testid="composer-textarea"]', 'div[contenteditable="true"]'];
export const CHATGPT_UPLOAD_SELECTORS = ['button[aria-label*="Upload" i]', 'button[aria-label*="Attach" i]', 'button[data-testid*="plus" i]'];
export const CHATGPT_RESPONSE_SELECTORS = ['[data-message-author-role="assistant"]', '[data-turn="assistant"]', 'article[data-testid^="conversation-turn"]'];
export const CHATGPT_STREAMING_SELECTORS = ['button[data-testid="stop-button"]', 'button[aria-label*="Stop" i]'];

export const GEMINI_COMPOSER_SELECTORS = ['rich-textarea .ql-editor', '[role="textbox"][aria-label*="prompt" i]', 'div[contenteditable="true"]'];
export const GEMINI_MODEL_SELECTOR_BUTTONS = ['button[data-test-id="bard-mode-menu-button"]', 'button[aria-label="Open mode picker"]'];
export const GEMINI_UPLOAD_SELECTORS = ['button[aria-label="Open upload file menu"]', 'button[aria-label*="upload file menu" i]'];
export const GEMINI_RESPONSE_SELECTORS = ['model-response', '[data-response-index]'];
export const GEMINI_STREAMING_SELECTORS = ['.response-footer.complete', 'message-actions', '[aria-label*="Good response" i]'];

export const GROK_COMPOSER_SELECTORS = ['.ProseMirror[contenteditable="true"]', '[contenteditable="true"].ProseMirror'];
export const GROK_MODEL_SELECTOR_BUTTONS = ['button[aria-label="Model select"]', 'button[aria-label*="Model select" i]'];
export const GROK_UPLOAD_SELECTORS = ['button[aria-label*="Upload" i]', 'button[aria-label*="Attach" i]', 'button[data-testid*="plus" i]'];
export const GROK_RESPONSE_SELECTORS = ['[data-testid="assistant-message"]', '[id^="response-"]:has([data-testid="assistant-message"])'];
export const GROK_STREAMING_SELECTORS = ['button[aria-label*="Stop" i]'];

interface SemanticTarget {
    roles?: readonly string[];
    names?: readonly RegExp[];
    excludeNames?: readonly RegExp[];
    cssFallbacks?: readonly string[];
    required?: boolean;
}

export interface EditorContract {
    vendor: string;
    semanticTargets: Record<string, SemanticTarget>;
}

export const CHATGPT_EDITOR_CONTRACT: EditorContract = Object.freeze({
    vendor: 'chatgpt',
    semanticTargets: {
        composer: { roles: ['textbox'], names: [/message/i, /prompt/i, /chatgpt/i], excludeNames: [/search/i], cssFallbacks: CHATGPT_COMPOSER_SELECTORS, required: true },
        modelPicker: { roles: ['button', 'combobox'], names: [/model/i, /gpt/i], cssFallbacks: CHATGPT_MODEL_SELECTOR_BUTTONS },
        uploadSurface: { roles: ['button'], names: [/attach/i, /upload/i, /file/i, /add/i], cssFallbacks: CHATGPT_UPLOAD_SELECTORS },
        responseFeed: { roles: ['article', 'region', 'group'], names: [/assistant/i, /response/i], cssFallbacks: CHATGPT_RESPONSE_SELECTORS },
        copyButton: { roles: ['button'], names: [/copy/i], cssFallbacks: CHATGPT_COPY_SELECTORS.copyButtonSelectors },
        streamingIndicator: { roles: ['button'], names: [/stop/i], cssFallbacks: CHATGPT_STREAMING_SELECTORS },
    },
});

export const GEMINI_EDITOR_CONTRACT: EditorContract = Object.freeze({
    vendor: 'gemini',
    semanticTargets: {
        composer: { roles: ['textbox'], names: [/prompt/i, /message/i, /ask/i], excludeNames: [/search/i], cssFallbacks: GEMINI_COMPOSER_SELECTORS, required: true },
        modelPicker: { roles: ['button', 'combobox'], names: [/model/i, /mode/i, /picker/i], cssFallbacks: GEMINI_MODEL_SELECTOR_BUTTONS },
        uploadSurface: { roles: ['button'], names: [/upload/i, /file/i, /attach/i], cssFallbacks: GEMINI_UPLOAD_SELECTORS },
        responseFeed: { roles: ['article', 'region', 'group'], names: [/response/i, /gemini/i], cssFallbacks: GEMINI_RESPONSE_SELECTORS },
        copyButton: { roles: ['button'], names: [/copy/i], cssFallbacks: GEMINI_COPY_SELECTORS.copyButtonSelectors },
        streamingIndicator: { roles: ['button', 'status'], names: [/stop/i, /response/i], cssFallbacks: GEMINI_STREAMING_SELECTORS },
    },
});

export const GROK_EDITOR_CONTRACT: EditorContract = Object.freeze({
    vendor: 'grok',
    semanticTargets: {
        composer: { roles: ['textbox'], names: [/message/i, /prompt/i, /ask/i, /grok/i], excludeNames: [/search/i], cssFallbacks: GROK_COMPOSER_SELECTORS, required: true },
        modelPicker: { roles: ['button', 'combobox'], names: [/model/i], cssFallbacks: GROK_MODEL_SELECTOR_BUTTONS },
        uploadSurface: { roles: ['button'], names: [/upload/i, /attach/i, /file/i], cssFallbacks: GROK_UPLOAD_SELECTORS },
        responseFeed: { roles: ['article', 'region', 'group'], names: [/assistant/i, /response/i], cssFallbacks: GROK_RESPONSE_SELECTORS },
        copyButton: { roles: ['button'], names: [/copy/i], cssFallbacks: GROK_COPY_SELECTORS.copyButtonSelectors },
        streamingIndicator: { roles: ['button'], names: [/stop/i], cssFallbacks: GROK_STREAMING_SELECTORS },
    },
});

export const EDITOR_CONTRACT_BY_VENDOR: Record<string, EditorContract> = Object.freeze({
    chatgpt: CHATGPT_EDITOR_CONTRACT,
    gemini: GEMINI_EDITOR_CONTRACT,
    grok: GROK_EDITOR_CONTRACT,
});

export function editorContractForVendor(vendor = 'chatgpt'): EditorContract {
    return EDITOR_CONTRACT_BY_VENDOR[vendor] || CHATGPT_EDITOR_CONTRACT;
}

export function semanticTargetsForVendor(vendor = 'chatgpt'): Record<string, SemanticTarget> {
    return editorContractForVendor(vendor).semanticTargets;
}
