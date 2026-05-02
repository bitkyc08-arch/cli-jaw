import test from 'node:test';
import assert from 'node:assert/strict';
import {
    locatorForResolvedTarget,
    resolveActionTarget,
    resolveIntentFeature,
    validateResolvedTarget,
} from '../../src/browser/web-ai/self-heal.ts';
import { WebAiError } from '../../src/browser/web-ai/errors.ts';

function makeLocator(input: { count?: number; visible?: boolean; enabled?: boolean; editable?: boolean; role?: string; label?: string; tagName?: string }) {
    const locator = {
        async count() { return input.count ?? 1; },
        first() { return locator; },
        async isVisible() { return input.visible ?? true; },
        async isEnabled() { return input.enabled ?? true; },
        async isEditable() { return input.editable ?? true; },
        async evaluate<T>(fn: (node: any) => T): Promise<T> {
            return fn({
                getAttribute(name: string) {
                    if (name === 'role') return input.role || null;
                    if (name === 'aria-label') return input.label || '';
                    return null;
                },
                tagName: input.tagName || 'TEXTAREA',
                isContentEditable: input.editable ?? true,
                contentEditable: input.editable === false ? 'false' : 'true',
                textContent: input.label || '',
            });
        },
    };
    return locator;
}

test('self-heal resolves composer.fill from css fallback and validates fill target', async () => {
    const page = {
        url: () => 'https://chatgpt.com/',
        locator: (selector: string) => selector === '#prompt-textarea'
            ? makeLocator({ role: 'textbox', label: 'Message ChatGPT', editable: true })
            : makeLocator({ count: 0 }),
        getByRole: () => makeLocator({ role: 'textbox', label: 'Message ChatGPT' }),
    };

    const result = await resolveActionTarget(page, {
        provider: 'chatgpt',
        intent: 'composer.fill',
        actionKind: 'fill',
    });

    assert.equal(resolveIntentFeature('composer.fill'), 'composer');
    assert.equal(result.ok, true);
    assert.equal(result.target?.selector, '#prompt-textarea');
    assert.equal(result.target?.resolution, 'css-fallback');
});

test('self-heal rejects ambiguous selectors and throws WebAiError for unresolved refs', async () => {
    const page = {
        url: () => 'https://chatgpt.com/',
        locator: () => makeLocator({ count: 2 }),
        getByRole: () => makeLocator({ count: 0 }),
    };

    const validation = await validateResolvedTarget(page, { selector: '.many' }, { actionKind: 'click' });
    assert.equal(validation.ok, false);
    assert.equal(validation.reason, 'ambiguous-selector');

    await assert.rejects(
        () => locatorForResolvedTarget(page, { ref: '@e1' }),
        (err: unknown) => err instanceof WebAiError && err.stage === 'self-heal',
    );
});
