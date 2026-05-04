import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const composerSrc = fs.readFileSync(join(root, 'src/browser/web-ai/chatgpt-composer.ts'), 'utf8');
const chatgptSrc = fs.readFileSync(join(root, 'src/browser/web-ai/chatgpt.ts'), 'utf8');
const modelSrc = fs.readFileSync(join(root, 'src/browser/web-ai/chatgpt-model.ts'), 'utf8');

test('BWCOMP-001: ChatGPT composer uses user-input insertion path', () => {
    assert.match(chatgptSrc, /Input\.insertText/);
    assert.match(composerSrc, /insertTextLikeProvider/);
    assert.doesNotMatch(chatgptSrc, /await fillComposer/);
    assert.doesNotMatch(chatgptSrc, /locator\.fill/);
});

test('BWCOMP-002: send button is primary and Enter is fallback', () => {
    assert.match(composerSrc, /SEND_BUTTON_SELECTORS/);
    assert.match(composerSrc, /button\[data-testid="send-button"\]/);
    assert.match(composerSrc, /dispatchClickSequence/);
    assert.match(composerSrc, /pointerdown/);
    assert.match(composerSrc, /mousedown/);
    assert.match(composerSrc, /submitPromptFromComposer/);
    assert.match(composerSrc, /keyboard\.press\('Enter'\)/);
});

test('BWCOMP-003: composer verification reads multiple paths', () => {
    assert.match(composerSrc, /editorText/);
    assert.match(composerSrc, /fallbackValue/);
    assert.match(composerSrc, /activeValue/);
    assert.match(composerSrc, /normalizePrompt\(expected\)/);
});

test('BWCOMP-004: composer selection prefers visible candidates', () => {
    assert.match(composerSrc, /findVisibleCandidate/);
    assert.match(composerSrc, /allowFirstCandidateFallback: true/);
});

test('BWCOMP-005: prompt commit verification checks post-send conversation state', () => {
    assert.match(composerSrc, /CONVERSATION_TURN_SELECTOR/);
    assert.match(composerSrc, /STOP_BUTTON_SELECTOR/);
    assert.match(composerSrc, /ASSISTANT_ROLE_SELECTOR/);
    assert.match(composerSrc, /composerCleared/);
});

test('BWCOMP-006: file upload Phase B live runtime is exported', () => {
    const attSrc = fs.readFileSync(join(root, 'src/browser/web-ai/chatgpt-attachments.ts'), 'utf8');
    assert.match(attSrc, /attachLocalFileLive/);
    assert.match(attSrc, /waitForAttachmentAcceptedLive/);
    assert.match(attSrc, /verifySentTurnAttachmentLive/);
});

test('BWCOMP-007: ChatGPT model selector uses observed radio menu fallbacks', () => {
    assert.match(modelSrc, /model-switcher-dropdown-button/);
    assert.match(modelSrc, /__composer-pill/);
    assert.match(modelSrc, /composer-model-pill/);
    assert.match(modelSrc, /Instant\|Fast\|Thinking\|Pro\|Heavy/);
    assert.match(modelSrc, /model-switcher-gpt-5-3/);
    assert.match(modelSrc, /model-switcher-gpt-5-5-thinking/);
    assert.match(modelSrc, /model-switcher-gpt-5-5-pro/);
    assert.match(modelSrc, /model-switcher-gpt-5-5-pro-thinking-effort/);
    assert.match(modelSrc, /CHATGPT_MODEL_EFFORT_OPTIONS/);
    assert.match(modelSrc, /Extended Pro/);
    assert.match(modelSrc, /Heavy/);
    assert.match(modelSrc, /aria-checked="true"/);
    assert.match(chatgptSrc, /selectChatGptModel\(page, input\.model, \{ effort: input\.reasoningEffort \}\)/);
    assert.match(chatgptSrc, /reasoning effort selected/);
});

test('BWCOMP-007b: ChatGPT model selector can choose all supported reasoning efforts when model text comes first', async () => {
    const { selectChatGptModel } = await import('../../src/browser/web-ai/chatgpt-model.js');

    for (const effort of ['light', 'standard', 'extended', 'heavy']) {
        const page = createFakeModelPage({
            model: 'thinking',
            effortTexts: {
                light: 'GPT-5.5 Thinking Light',
                standard: 'GPT-5.5 Thinking Standard',
                extended: 'GPT-5.5 Thinking Extended',
                heavy: 'GPT-5.5 Thinking Heavy',
            },
        });
        const result = await selectChatGptModel(page, 'thinking', { effort });
        assert.equal(result?.selected, 'thinking');
        assert.equal(result?.effort, effort);
    }

    for (const effort of ['standard', 'extended']) {
        const page = createFakeModelPage({
            model: 'pro',
            effortTexts: {
                standard: 'GPT-5.5 Pro Standard',
                extended: 'GPT-5.5 Pro Extended',
            },
        });
        const result = await selectChatGptModel(page, 'pro', { effort });
        assert.equal(result?.selected, 'pro');
        assert.equal(result?.effort, effort);
    }
});

test('BWCOMP-007b2: ChatGPT selector does not treat the closed model dropdown button as an open model menu', async () => {
    const { selectChatGptModel } = await import('../../src/browser/web-ai/chatgpt-model.js');
    const page = createFakeModelPage({
        model: 'thinking',
        initialModelMenuOpen: false,
        closedDropdownButton: true,
        effortTexts: thinkingEffortTexts(),
    });

    const result = await selectChatGptModel(page, 'thinking', { effort: 'standard' });

    assert.equal(result?.selected, 'thinking');
    assert.equal(result?.effort, 'standard');
});

test('BWCOMP-007c: ChatGPT reasoning menu opens through generic effort controls for every supported effort when exact ids are absent', async () => {
    const { selectChatGptModel } = await import('../../src/browser/web-ai/chatgpt-model.js');
    const cases = [
        { model: 'thinking', efforts: ['light', 'standard', 'extended', 'heavy'], effortTexts: thinkingEffortTexts() },
        { model: 'pro', efforts: ['standard', 'extended'], effortTexts: proEffortTexts() },
    ];

    for (const { model, efforts, effortTexts } of cases) {
        for (const effort of efforts) {
            const page = createFakeModelPage({
                model,
                exactEffortTrigger: false,
                genericEffortTrigger: true,
                effortTexts,
            });
            const result = await selectChatGptModel(page, model, { effort });

            assert.equal(result?.selected, model);
            assert.equal(result?.effort, effort);
            assert.ok(result?.usedFallbacks.includes(`${model}-effort-generic-trigger`));
        }
    }
});

test('BWCOMP-007c2: ChatGPT selector falls through when exact effort triggers are hidden for every supported effort', async () => {
    const { selectChatGptModel } = await import('../../src/browser/web-ai/chatgpt-model.js');
    const cases = [
        { model: 'thinking', efforts: ['light', 'standard', 'extended', 'heavy'], effortTexts: thinkingEffortTexts() },
        { model: 'pro', efforts: ['standard', 'extended'], effortTexts: proEffortTexts() },
    ];

    for (const { model, efforts, effortTexts } of cases) {
        for (const effort of efforts) {
            const page = createFakeModelPage({
                model,
                exactEffortTrigger: true,
                exactEffortTriggerVisible: false,
                genericEffortTrigger: true,
                effortTexts,
            });
            const result = await selectChatGptModel(page, model, { effort });

            assert.equal(result?.selected, model);
            assert.equal(result?.effort, effort);
            assert.ok(result?.usedFallbacks.includes(`${model}-effort-generic-trigger`));
        }
    }
});

test('BWCOMP-007c2b: ChatGPT selector does not treat a closed hero effort pill as an open model menu', async () => {
    const { selectChatGptModel } = await import('../../src/browser/web-ai/chatgpt-model.js');
    const page = createFakeModelPage({
        model: 'pro',
        initialModelMenuOpen: false,
        closedHeroEffortPill: true,
        checkedModelRows: false,
        effortTexts: proEffortTexts(),
    });

    const result = await selectChatGptModel(page, 'pro', { effort: 'standard' });

    assert.equal(result?.selected, 'pro');
    assert.equal(result?.effort, 'standard');
});

test('BWCOMP-007c2c: ChatGPT selector does not treat a visible effort trigger as the model row when model row test ids disappear', async () => {
    const { selectChatGptModel } = await import('../../src/browser/web-ai/chatgpt-model.js');
    const page = createFakeModelPage({
        model: 'thinking',
        exactEffortTrigger: true,
        exactEffortTriggerModel: 'pro',
        missingModelTestIds: ['model-switcher-gpt-5-5-pro'],
        effortTexts: thinkingEffortTexts(),
    });

    const result = await selectChatGptModel(page, 'pro');

    assert.equal(result?.selected, 'pro');
    assert.equal(result?.alreadySelected, false);
});

test('BWCOMP-007c2c2: ChatGPT selector does not select a standalone Heavy exact effort trigger as the Pro model', async () => {
    const { selectChatGptModel } = await import('../../src/browser/web-ai/chatgpt-model.js');
    const page = createFakeModelPage({
        model: 'thinking',
        exactEffortTrigger: true,
        exactEffortTriggerModel: 'pro',
        exactEffortTriggerText: 'Heavy',
        missingModelTestIds: ['model-switcher-gpt-5-5-pro'],
        effortTexts: thinkingEffortTexts(),
    });

    const result = await selectChatGptModel(page, 'pro');

    assert.equal(result?.selected, 'pro');
    assert.equal(result?.alreadySelected, false);
});

test('BWCOMP-007c2c3: ChatGPT selector skips effort-only Pro labels when looking for a model row by text', async () => {
    const { selectChatGptModel } = await import('../../src/browser/web-ai/chatgpt-model.js');

    for (const strayModelMenuText of ['Heavy', 'Standard Pro', 'Extended Pro']) {
        const page = createFakeModelPage({
            model: 'thinking',
            missingModelTestIds: ['model-switcher-gpt-5-5-pro'],
            strayModelMenuTexts: [strayModelMenuText],
            effortTexts: thinkingEffortTexts(),
        });

        const result = await selectChatGptModel(page, 'pro');

        assert.equal(result?.selected, 'pro');
        assert.equal(result?.alreadySelected, false);
    }
});

test('BWCOMP-007c2d: ChatGPT selector selects menuitem-only effort options for every supported effort', async () => {
    const { selectChatGptModel } = await import('../../src/browser/web-ai/chatgpt-model.js');
    const cases = [
        { model: 'thinking', efforts: ['light', 'standard', 'extended', 'heavy'], effortTexts: thinkingEffortTexts() },
        { model: 'pro', efforts: ['standard', 'extended'], effortTexts: proEffortTexts() },
    ];

    for (const { model, efforts, effortTexts } of cases) {
        for (const effort of efforts) {
            const page = createFakeModelPage({
                model,
                exactEffortTrigger: false,
                effortOptionRole: 'menuitem',
                checkedEffortRows: false,
                effortTexts,
            });
            const result = await selectChatGptModel(page, model, { effort });

            assert.equal(result?.selected, model);
            assert.equal(result?.effort, effort);
        }
    }
});

test('BWCOMP-007c2e: ChatGPT selector dismisses a wrong exact-trigger effort menu before trying generic effort controls', async () => {
    const { selectChatGptModel } = await import('../../src/browser/web-ai/chatgpt-model.js');
    const page = createFakeModelPage({
        model: 'pro',
        exactEffortTrigger: true,
        genericEffortTrigger: true,
        effortTexts: thinkingEffortTexts(),
        genericEffortTexts: proEffortTexts(),
    });

    const result = await selectChatGptModel(page, 'pro', { effort: 'extended' });

    assert.equal(result?.selected, 'pro');
    assert.equal(result?.effort, 'extended');
    assert.ok(result?.usedFallbacks.includes('pro-effort-generic-trigger'));
});

test('BWCOMP-007c3: ChatGPT selector reopens the model menu after effort selection closes it for every supported effort', async () => {
    const { selectChatGptModel } = await import('../../src/browser/web-ai/chatgpt-model.js');
    const cases = [
        { model: 'thinking', efforts: ['light', 'standard', 'extended', 'heavy'], effortTexts: thinkingEffortTexts() },
        { model: 'pro', efforts: ['standard', 'extended'], effortTexts: proEffortTexts() },
    ];

    for (const { model, efforts, effortTexts } of cases) {
        for (const effort of efforts) {
            const page = createFakeModelPage({
                model,
                exactEffortTrigger: false,
                genericEffortTrigger: true,
                closeModelMenuOnEffortSelect: true,
                effortTexts,
            });
            const result = await selectChatGptModel(page, model, { effort });

            assert.equal(result?.selected, model);
            assert.equal(result?.effort, effort);
        }
    }
});

test('BWCOMP-007d: ChatGPT selector ignores a reasoning menu for the wrong model before selecting an effort', async () => {
    const { selectChatGptModel } = await import('../../src/browser/web-ai/chatgpt-model.js');
    const cases = [
        {
            model: 'thinking',
            efforts: ['light', 'standard', 'extended', 'heavy'],
            effortTexts: thinkingEffortTexts(),
            genericEffortTexts: proEffortTexts(),
        },
        {
            model: 'pro',
            efforts: ['standard', 'extended'],
            effortTexts: proEffortTexts(),
            genericEffortTexts: thinkingEffortTexts(),
        },
    ];

    for (const { model, efforts, effortTexts, genericEffortTexts } of cases) {
        for (const effort of efforts) {
            const page = createFakeModelPage({
                model,
                exactEffortTrigger: false,
                genericEffortTrigger: true,
                effortTexts,
                genericEffortTexts,
            });
            const result = await selectChatGptModel(page, model, { effort });

            assert.equal(result?.selected, model);
            assert.equal(result?.effort, effort);
            assert.ok(result?.usedFallbacks.includes(`${model}-effort-keyboard-open`));
            assert.equal(result?.usedFallbacks.includes(`${model}-effort-generic-trigger`), false);
        }
    }
});

test('BWCOMP-007e: ChatGPT selector rejects labels-only effort menus with unsupported labels for the requested model', async () => {
    const { selectChatGptModel } = await import('../../src/browser/web-ai/chatgpt-model.js');
    const page = createFakeModelPage({
        model: 'pro',
        exactEffortTrigger: false,
        genericEffortTrigger: true,
        effortTexts: labelsOnlyProEffortTexts(),
        genericEffortTexts: labelsOnlyThinkingEffortTexts(),
    });

    const result = await selectChatGptModel(page, 'pro', { effort: 'extended' });

    assert.equal(result?.selected, 'pro');
    assert.equal(result?.effort, 'extended');
    assert.ok(result?.usedFallbacks.includes('pro-effort-keyboard-open'));
    assert.equal(result?.usedFallbacks.includes('pro-effort-generic-trigger'), false);
});

test('BWCOMP-007e2: ChatGPT selector accepts plan-base Thinking standard and extended menus without requiring Pro-only light or heavy labels', async () => {
    const { selectChatGptModel } = await import('../../src/browser/web-ai/chatgpt-model.js');
    for (const effort of ['standard', 'extended']) {
        const page = createFakeModelPage({
            model: 'thinking',
            exactEffortTrigger: false,
            genericEffortTrigger: true,
            effortTexts: labelsOnlyProEffortTexts(),
            genericEffortTexts: labelsOnlyProEffortTexts(),
        });

        const result = await selectChatGptModel(page, 'thinking', { effort });

        assert.equal(result?.selected, 'thinking');
        assert.equal(result?.effort, effort);
        assert.ok(result?.usedFallbacks.includes('thinking-effort-keyboard-open'));
        assert.equal(result?.usedFallbacks.includes('thinking-effort-generic-trigger'), false);
    }

    for (const effort of ['light', 'heavy']) {
        const page = createFakeModelPage({
            model: 'thinking',
            exactEffortTrigger: false,
            genericEffortTrigger: true,
            effortTexts: labelsOnlyProEffortTexts(),
            genericEffortTexts: labelsOnlyProEffortTexts(),
        });

        await assert.rejects(
            () => selectChatGptModel(page, 'thinking', { effort }),
            /reasoning effort selector not found/,
        );
    }
});

test('BWCOMP-007f: ChatGPT selector does not trust overlapping labels-only menus from broad generic effort triggers', async () => {
    const { selectChatGptModel } = await import('../../src/browser/web-ai/chatgpt-model.js');
    const page = createFakeModelPage({
        model: 'pro',
        exactEffortTrigger: false,
        genericEffortTrigger: true,
        effortTexts: labelsOnlyProEffortTexts(),
        genericEffortTexts: labelsOnlyProEffortTexts(),
    });

    const result = await selectChatGptModel(page, 'pro', { effort: 'standard' });

    assert.equal(result?.selected, 'pro');
    assert.equal(result?.effort, 'standard');
    assert.ok(result?.usedFallbacks.includes('pro-effort-keyboard-open'));
    assert.equal(result?.usedFallbacks.includes('pro-effort-generic-trigger'), false);
});

test('BWCOMP-007g: ChatGPT selector does not reuse a rejected labels-only generic menu as a later row-bound success', async () => {
    const { selectChatGptModel } = await import('../../src/browser/web-ai/chatgpt-model.js');
    const page = createFakeModelPage({
        model: 'pro',
        exactEffortTrigger: false,
        genericEffortTrigger: true,
        effortTexts: labelsOnlyProEffortTexts(),
        genericEffortTexts: labelsOnlyProEffortTexts(),
        keyboardOpensEffort: false,
    });

    await assert.rejects(
        () => selectChatGptModel(page, 'pro', { effort: 'standard' }),
        /reasoning effort selector not found/,
    );
});

test('BWCOMP-007h: ChatGPT selector opens visible-text-only effort controls without data-testid or aria-label hooks', async () => {
    const { selectChatGptModel } = await import('../../src/browser/web-ai/chatgpt-model.js');
    const page = createFakeModelPage({
        model: 'thinking',
        exactEffortTrigger: false,
        genericEffortTrigger: true,
        genericTriggerMode: 'text',
        effortTexts: thinkingEffortTexts(),
    });

    const result = await selectChatGptModel(page, 'thinking', { effort: 'extended' });

    assert.equal(result?.selected, 'thinking');
    assert.equal(result?.effort, 'extended');
    assert.ok(result?.usedFallbacks.includes('thinking-effort-text-trigger'));
});

test('BWCOMP-007i: ChatGPT selector verifies effort from active pill when checked effort rows disappear', async () => {
    const { selectChatGptModel } = await import('../../src/browser/web-ai/chatgpt-model.js');
    const page = createFakeModelPage({
        model: 'thinking',
        effortTexts: thinkingEffortTexts(),
        checkedEffortRows: false,
    });

    const result = await selectChatGptModel(page, 'thinking', { effort: 'heavy' });

    assert.equal(result?.selected, 'thinking');
    assert.equal(result?.effort, 'heavy');
});

test('BWCOMP-007j: ChatGPT selector verifies effort from a role-button composer pill', async () => {
    const { selectChatGptModel } = await import('../../src/browser/web-ai/chatgpt-model.js');
    const page = createFakeModelPage({
        model: 'thinking',
        effortTexts: thinkingEffortTexts(),
        checkedEffortRows: false,
        roleButtonPill: true,
    });

    const result = await selectChatGptModel(page, 'thinking', { effort: 'standard' });

    assert.equal(result?.selected, 'thinking');
    assert.equal(result?.effort, 'standard');
});

test('BWCOMP-007k: ChatGPT selector ignores checked labels-only effort rows when verifying the selected model', async () => {
    const { selectChatGptModel } = await import('../../src/browser/web-ai/chatgpt-model.js');
    const page = createFakeModelPage({
        model: 'thinking',
        effortTexts: labelsOnlyThinkingEffortTexts(),
        activePillTexts: { heavy: 'GPT-5.5 Thinking Heavy' },
        checkedModelRows: false,
        roleButtonPill: true,
    });

    const result = await selectChatGptModel(page, 'thinking', { effort: 'heavy' });

    assert.equal(result?.selected, 'thinking');
    assert.equal(result?.effort, 'heavy');
});

test('BWCOMP-007l: ChatGPT selector does not read a standalone Heavy effort pill as the Pro model on split-pill hero UI', async () => {
    const { selectChatGptModel } = await import('../../src/browser/web-ai/chatgpt-model.js');
    const page = createFakeModelPage({
        model: 'thinking',
        effortTexts: thinkingEffortTexts(),
        activePillTexts: { heavy: 'Heavy' },
        splitModelPillText: 'GPT-5.5 Thinking',
        checkedModelRows: false,
        checkedEffortRows: false,
        roleButtonPill: true,
    });

    const result = await selectChatGptModel(page, 'thinking', { effort: 'heavy' });

    assert.equal(result?.selected, 'thinking');
    assert.equal(result?.effort, 'heavy');
});

test('BWCOMP-007m: ChatGPT selector does not treat Thinking Heavy split-pill state as already selected Pro', async () => {
    const { selectChatGptModel } = await import('../../src/browser/web-ai/chatgpt-model.js');
    const page = createFakeModelPage({
        model: 'thinking',
        initialSelectedEffort: 'heavy',
        effortTexts: thinkingEffortTexts(),
        activePillTexts: { heavy: 'Heavy' },
        splitModelPillText: state => state.currentModel === 'pro' ? 'GPT-5.5 Pro' : 'GPT-5.5 Thinking',
        checkedModelRows: false,
        roleButtonPill: true,
    });

    const result = await selectChatGptModel(page, 'pro');

    assert.equal(result?.selected, 'pro');
    assert.equal(result?.alreadySelected, false);
});

test('BWCOMP-008: ChatGPT reasoning effort is exposed through CLI and typed input', () => {
    const cliSrc = fs.readFileSync(join(root, 'bin/commands/browser-web-ai.ts'), 'utf8');
    const typesSrc = fs.readFileSync(join(root, 'src/browser/web-ai/types.ts'), 'utf8');
    assert.match(cliSrc, /effort: \{ type: 'string' \}/);
    assert.match(cliSrc, /'reasoning-effort': \{ type: 'string' \}/);
    assert.match(cliSrc, /reasoningEffort: values\.effort \|\| values\['reasoning-effort'\]/);
    assert.match(cliSrc, /reasoning effort requires --model/);
    assert.match(cliSrc, /modelKey = String\(model \|\| ''\)/);
    assert.match(typesSrc, /reasoningEffort\?: string/);
});

function thinkingEffortTexts(): Record<string, string> {
    return {
        light: 'GPT-5.5 Thinking Light',
        standard: 'GPT-5.5 Thinking Standard',
        extended: 'GPT-5.5 Thinking Extended',
        heavy: 'GPT-5.5 Thinking Heavy',
    };
}

function proEffortTexts(): Record<string, string> {
    return {
        standard: 'GPT-5.5 Pro Standard',
        extended: 'GPT-5.5 Pro Extended',
    };
}

function labelsOnlyThinkingEffortTexts(): Record<string, string> {
    return {
        light: 'Light',
        standard: 'Standard',
        extended: 'Extended',
        heavy: 'Heavy',
    };
}

function labelsOnlyProEffortTexts(): Record<string, string> {
    return {
        standard: 'Standard',
        extended: 'Extended',
    };
}

function createFakeModelPage(input: {
    model?: string;
    effortTexts?: Record<string, string>;
    activePillTexts?: Record<string, string>;
    genericEffortTexts?: Record<string, string>;
    initialSelectedEffort?: string;
    checkedEffortRows?: boolean;
    checkedModelRows?: boolean;
    roleButtonPill?: boolean;
    keyboardOpensEffort?: boolean;
    closeModelMenuOnEffortSelect?: boolean;
    initialModelMenuOpen?: boolean;
    closedDropdownButton?: boolean;
    exactEffortTrigger?: boolean;
    exactEffortTriggerVisible?: boolean;
    genericEffortTrigger?: boolean;
    genericTriggerMode?: 'css' | 'text';
    splitModelPillText?: string | ((state: any) => string);
    closedHeroEffortPill?: boolean;
    missingModelTestIds?: string[];
    exactEffortTriggerModel?: string;
    exactEffortTriggerText?: string;
    strayModelMenuTexts?: string[];
    effortOptionRole?: 'menuitemradio' | 'menuitem';
} = {}): any {
    const effortTexts = input.effortTexts || {};
    const activePillTexts = input.activePillTexts || null;
    const genericEffortTexts = input.genericEffortTexts || null;
    const initialSelectedEffort = input.initialSelectedEffort || null;
    const checkedEffortRows = input.checkedEffortRows ?? true;
    const checkedModelRows = input.checkedModelRows ?? true;
    const roleButtonPill = input.roleButtonPill ?? false;
    const keyboardOpensEffort = input.keyboardOpensEffort ?? true;
    const closeModelMenuOnEffortSelect = input.closeModelMenuOnEffortSelect ?? false;
    const initialModelMenuOpen = input.initialModelMenuOpen ?? true;
    const closedDropdownButton = input.closedDropdownButton ?? false;
    const genericTriggerMode = input.genericTriggerMode || 'css';
    const splitModelPillText = input.splitModelPillText || null;
    const closedHeroEffortPill = input.closedHeroEffortPill ?? false;
    const missingModelTestIdSet = new Set(input.missingModelTestIds || []);
    const exactEffortTriggerModel = input.exactEffortTriggerModel || input.model || 'thinking';
    const exactEffortTriggerText = input.exactEffortTriggerText || 'Effort';
    const strayModelMenuTexts = input.strayModelMenuTexts || [];
    const effortOptionRole = input.effortOptionRole || 'menuitemradio';
    const state: any = {
        modelMenuOpen: initialModelMenuOpen,
        effortMenuOpen: false,
        currentModel: input.model || 'thinking',
        selectedEffort: initialSelectedEffort,
        effortMenuSource: null,
        exactEffortTrigger: input.exactEffortTrigger ?? false,
        exactEffortTriggerVisible: input.exactEffortTriggerVisible ?? true,
        genericEffortTrigger: input.genericEffortTrigger ?? true,
    };
    const modelRows = [
        createElement({
            text: 'GPT-5.3 Instant',
            testId: modelRowTestId('model-switcher-gpt-5-3'),
            checked: () => checkedModelRows && state.currentModel === 'instant',
            onClick: () => setModel('instant'),
        }),
        createElement({
            text: 'GPT-5.5 Thinking',
            testId: modelRowTestId('model-switcher-gpt-5-5-thinking'),
            checked: () => checkedModelRows && state.currentModel === 'thinking',
            onClick: () => setModel('thinking'),
        }),
        createElement({
            text: 'GPT-5.5 Pro',
            testId: modelRowTestId('model-switcher-gpt-5-5-pro'),
            checked: () => checkedModelRows && state.currentModel === 'pro',
            onClick: () => setModel('pro'),
        }),
    ];
    const exactTrigger = createElement({
        text: exactEffortTriggerText,
        testId: `model-switcher-gpt-5-5-${exactEffortTriggerModel}-thinking-effort`,
        onClick: () => openEffortRows('target'),
        visible: state.exactEffortTriggerVisible,
    });
    const strayModelMenuItems = strayModelMenuTexts.map(text => createElement({
        text,
        onClick: () => openEffortRows('target'),
    }));
    const genericTrigger = createElement({
        text: 'Reasoning effort',
        onClick: () => openEffortRows('generic'),
    });
    const dropdownButton = createElement({
        text: 'ChatGPT',
        testId: 'model-switcher-dropdown-button',
        onClick: () => { state.modelMenuOpen = true; },
        visible: closedDropdownButton,
    });
    const modelPill = createElement({
        text: () => state.selectedEffort
            ? `${activePillTexts?.[state.selectedEffort] || effortTexts[state.selectedEffort] || currentEffortTexts()[state.selectedEffort] || state.currentModel}`
            : state.currentModel,
        onClick: () => { state.modelMenuOpen = true; },
    });
    const splitModelPill = createElement({
        text: () => typeof splitModelPillText === 'function' ? splitModelPillText(state) : splitModelPillText || state.currentModel,
        onClick: () => { state.modelMenuOpen = true; },
    });
    const closedHeroPill = createElement({
        text: 'Standard Pro',
        testId: 'model-switcher-gpt-5-5-pro-thinking-effort',
        onClick: () => { state.modelMenuOpen = true; },
    });

    return {
        keyboard: {
            press: async (key: string) => {
                if (key === 'Escape') {
                    if (state.effortMenuOpen) {
                        state.effortMenuOpen = false;
                        state.effortMenuSource = null;
                    } else {
                        state.modelMenuOpen = false;
                    }
                }
                if (key === 'ArrowRight' && keyboardOpensEffort) openEffortRows('target');
            },
        },
        mouse: {
            move: async () => undefined,
            click: async () => openEffortRows('target'),
        },
        waitForTimeout: async () => undefined,
        evaluate: async (_fn: any, arg: any) => {
            if (arg === exactTrigger.testId && state.exactEffortTrigger) return exactTrigger.rect;
            return null;
        },
        locator: (selector: string) => makeLocator(selectElements(selector), selector),
    };

    function openEffortRows(source: 'target' | 'generic'): void {
        state.effortMenuOpen = true;
        state.effortMenuSource = source;
    }

    function modelRowTestId(testId: string): string | undefined {
        return missingModelTestIdSet.has(testId) ? undefined : testId;
    }

    function setModel(nextModel: string): void {
        if (state.currentModel !== nextModel) state.selectedEffort = null;
        state.currentModel = nextModel;
    }

    function currentEffortTexts(): Record<string, string> {
        if (state.effortMenuSource === 'generic' && genericEffortTexts) return genericEffortTexts;
        return effortTexts;
    }

    function currentEffortRows(): any[] {
        return Object.entries(currentEffortTexts()).map(([effort, text]) => createElement({
            text,
            checked: () => checkedEffortRows && state.selectedEffort === effort,
            onClick: () => {
                state.selectedEffort = effort;
                state.effortMenuOpen = false;
                state.effortMenuSource = null;
                if (closeModelMenuOnEffortSelect) state.modelMenuOpen = false;
            },
        }));
    }

    function composerPills(): any[] {
        return splitModelPillText ? [splitModelPill, modelPill] : [modelPill];
    }

    function selectElements(selector: string): any[] {
        if (selector === 'button, [role="button"], [role="menuitem"]') return state.modelMenuOpen && !state.effortMenuOpen && state.genericEffortTrigger && genericTriggerMode === 'text' ? [...composerPills(), genericTrigger] : composerPills();
        if (selector.includes('__composer-pill')) return roleButtonPill ? composerPills() : [];
        if (selector === 'button') return roleButtonPill ? [] : [dropdownButton, ...composerPills(), closedHeroPill].filter(element => element.visible && (element !== closedHeroPill || closedHeroEffortPill));
        if (selector === '[role="menu"]') {
            return state.effortMenuOpen ? [createElement({ text: Object.values(currentEffortTexts()).join('\n') })] : [];
        }
        if (selector === '[data-testid^="model-switcher-"]') return state.modelMenuOpen ? modelRows.filter(element => element.testId) : (closedHeroEffortPill ? [closedHeroPill] : []);
        if (selector === '[data-testid^="model-switcher-gpt-"]') return state.modelMenuOpen ? modelRows.filter(element => element.testId) : (closedHeroEffortPill ? [closedHeroPill] : []);
        if (selector === '[role="menuitemradio"], [role="menuitem"]') return state.effortMenuOpen ? currentEffortRows() : [...strayModelMenuItems, ...modelRows];
        if (selector === '[role="menuitemradio"]') return state.effortMenuOpen && effortOptionRole === 'menuitemradio' ? currentEffortRows() : [];
        if (selector === '[role="menuitem"]') return state.effortMenuOpen && effortOptionRole === 'menuitem' ? currentEffortRows() : [];
        if (selector.includes('aria-checked="true"') || selector.includes('data-state="checked"')) {
            const checkedTestId = selector.match(/data-testid="([^"]+)"/)?.[1];
            return [...modelRows, ...currentEffortRows()]
                .filter(element => element.checked)
                .filter(element => !checkedTestId || element.testId === checkedTestId);
        }
        const testId = selector.match(/data-testid="([^"]+)"/)?.[1];
        if (testId) {
            if (testId === 'model-switcher-dropdown-button') return closedDropdownButton ? [dropdownButton] : [];
            if (testId.includes('thinking-effort')) return state.modelMenuOpen && state.exactEffortTrigger && testId === exactTrigger.testId ? [exactTrigger] : [];
            return state.modelMenuOpen ? modelRows.filter(element => element.testId === testId) : [];
        }
        if (/Effort|Reasoning|effort/i.test(selector)) return state.modelMenuOpen && !state.effortMenuOpen && state.genericEffortTrigger && genericTriggerMode === 'css' ? [genericTrigger] : [];
        return [];
    }
}

function createElement(input: {
    text?: string | (() => string);
    testId?: string;
    checked?: () => boolean;
    onClick?: () => void;
    visible?: boolean;
    rect?: { x: number; y: number; width: number; height: number };
} = {}): any {
    return {
        get text() { return typeof input.text === 'function' ? input.text() : input.text || ''; },
        testId: input.testId || null,
        get checked() { return input.checked?.() ?? false; },
        onClick: input.onClick || (() => undefined),
        visible: input.visible ?? true,
        rect: input.rect || { x: 10, y: 10, width: 120, height: 32 },
    };
}

function makeLocator(elements: any[], selector = ''): any {
    return {
        first: () => makeLocator(elements.slice(0, 1), selector),
        last: () => makeLocator(elements.slice(-1), selector),
        nth: (index: number) => makeLocator(elements.slice(index, index + 1), selector),
        filter: ({ hasText }: { hasText?: RegExp | string } = {}) => makeLocator(elements.filter(element => {
            if (!hasText) return true;
            if (hasText instanceof RegExp) return hasText.test(element.text);
            return element.text.includes(String(hasText));
        }), selector),
        count: async () => elements.length,
        all: async () => elements.map(element => makeLocator([element], selector)),
        isVisible: async () => Boolean(elements[0]?.visible),
        click: async () => {
            if (elements[0]?.visible === false) throw new Error('element not visible');
            return elements[0]?.onClick();
        },
        hover: async () => undefined,
        focus: async () => undefined,
        boundingBox: async () => elements[0]?.rect || null,
        innerText: async () => elements[0]?.text || '',
        evaluateAll: async (fn: any, arg: any) => fn(elements.map(element => ({
            innerText: element.text,
            textContent: element.text,
            getAttribute: (name: string) => name === 'data-testid' ? element.testId : null,
        })), arg),
    };
}
