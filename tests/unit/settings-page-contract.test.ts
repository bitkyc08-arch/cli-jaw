import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import postcss from 'postcss';
import type { SettingsClient } from '../../public/manager/src/settings/types';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const globals = globalThis as unknown as Record<string, unknown>;
const replacements = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true, React: await import('react') };
const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
Object.assign(globals, replacements);
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { SettingsPage } = await import('../../public/manager/src/settings/SettingsPage');
const { Workbench } = await import('../../public/manager/src/components/Workbench');
const { CommandCenter } = await import('../../public/manager/src/components/CommandCenter');
const { WorkbenchSettingsToggle } = await import('../../public/manager/src/components/WorkbenchHeader');
const { ThemeSwitch } = await import('../../public/manager/src/components/ThemeSwitch');
const { settingsIcon } = await import('../../public/manager/src/settings/settings-icons');
await import('../../public/manager/src/settings/pages/Display');
after(() => {
    dom.window.close();
    for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globals[key];
    }
});
const client: SettingsClient = {
    async get<T>() { return { presentation: { mode: 'activity' }, tui: {} } as T; },
    async put<T>() { return {} as T; }, async post<T>() { return {} as T; }, async delete<T>() { return {} as T; },
};

test('full settings page exposes Back, grouped icon nav, scope title and keyboard return', async () => {
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container); let backs = 0;
    try {
        await act(async () => root.render(createElement(SettingsPage, {
            port: 3457, instanceUrl: '/i/3457', client, initialId: 'display', scopes: ['instance'], onBack: () => { backs++; },
        })));
        const back = container.querySelector<HTMLButtonElement>('.settings-back')!;
        assert.equal(back.textContent?.trim(), 'Back to workspace');
        assert.equal(document.activeElement, back);
        assert.equal(container.querySelector('.settings-page-heading h2')?.textContent, 'Display');
        assert.equal(container.querySelector('.settings-page-badge')?.textContent, 'Instance');
        assert.deepEqual([...container.querySelectorAll('[aria-current="page"]')].map(node => node.textContent?.trim()), ['Display']);
        assert.equal(container.querySelector('[aria-label="Runtime"] h3')?.textContent, 'Runtime');
        for (const item of container.querySelectorAll('.settings-sidebar-item')) {
            assert.ok(item.querySelector('svg'), 'every category has a registry glyph');
            assert.equal(item.getAttribute('title'), item.textContent?.trim());
        }
        await act(async () => back.click()); assert.equal(backs, 1);
        await act(async () => back.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        assert.equal(backs, 2);
        const dialog = document.createElement('dialog'); container.querySelector('.settings-shell')!.append(dialog);
        dialog.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        assert.equal(backs, 2, 'nested dialogs own Escape');
        assert.equal(settingsIcon('unknown-category'), 'settings');
    } finally { await act(async () => root.unmount()); container.remove(); }
});

test('settings replaces the workspace without replacing its preview iframe', async () => {
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    const render = async (open: boolean) => act(async () => root.render(createElement(Workbench, {
        mode: 'preview', onModeChange() {}, header: 'Instance', preview: createElement('iframe', { title: 'Preview' }),
        overview: 'Overview', logs: 'Logs', settings: createElement('div', {}, 'Settings content'),
        settingsOpen: open, onSettingsClose() {}, active: true,
    })));
    try {
        await render(false); const frame = container.querySelector('iframe');
        await render(true);
        assert.equal(container.querySelector('iframe'), frame);
        assert.equal(container.querySelector<HTMLElement>('[data-preview-host]')?.hidden, true);
        assert.equal(container.querySelector<HTMLElement>('.workbench-header')?.hidden, true);
        assert.equal(container.querySelector('.workbench-body > .workbench-settings-page')?.textContent, 'Settings content');
        assert.equal(container.querySelector('aside'), null);
        await render(false);
        assert.equal(container.querySelector('iframe'), frame);
        assert.equal(container.querySelector<HTMLElement>('[data-preview-host]')?.hidden, false);
    } finally { await act(async () => root.unmount()); container.remove(); }
});

test('command gear mounts immediately before theme controls and retains its toggle callback', async () => {
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container); let toggles = 0;
    try {
        await act(async () => root.render(createElement('div', {},
            createElement(CommandCenter, { title: 'Dashboard', search: null, mobileMenuButton: null,
                actions: createElement('div', { className: 'command-actions-group' }, createElement(ThemeSwitch, { theme: 'dark', onChange() {} })) }),
            createElement(WorkbenchSettingsToggle, { open: true, onToggle: () => { toggles++; } }))));
        const gear = container.querySelector<HTMLButtonElement>('.workbench-settings-toggle')!;
        assert.equal(gear.getAttribute('aria-pressed'), 'true');
        assert.equal(gear.parentElement?.nextElementSibling?.getAttribute('aria-label'), 'Theme');
        gear.click(); assert.equal(toggles, 1);
    } finally { await act(async () => root.unmount()); container.remove(); }
});

test('settings CSS specifies the measured card, row and responsive navigation geometry', () => {
    const sheet = postcss.parse(readFileSync('public/manager/src/settings-shell.css', 'utf8') + readFileSync('public/manager/src/settings-controls.css', 'utf8'));
    const value = (selector: string, property: string) => {
        let result: string | undefined;
        sheet.walkRules(rule => {
            if (rule.parent?.type !== 'root' || !rule.selectors.includes(selector)) return;
            rule.walkDecls(property, decl => { result = decl.value; });
        });
        return result;
    };
    assert.equal(value('.settings-shell', 'grid-template-columns'), '264px minmax(0, 1fr)');
    assert.equal(value('.settings-page-main', 'max-width'), '896px');
    assert.equal(value('.settings-page', 'border-radius'), '12px');
    assert.equal(value('.settings-nav-icon svg', 'width'), '16px');
    assert.equal(value('.settings-page-heading h2', 'font-size'), '24px');
    assert.equal(value('.settings-shell .settings-field', 'grid-template-columns'), 'minmax(0,1fr) 192px');
    assert.equal(value('.settings-shell .settings-field', 'padding'), '12px 16px');
    assert.equal(value('.settings-shell .settings-field', 'border-top'), '1px solid var(--settings-border)');
    let mobileGrid: string | undefined;
    sheet.walkAtRules('media', at => { if (at.params === '(max-width: 1023px)') at.walkRules('.settings-shell', rule => { rule.walkDecls('grid-template-columns', decl => { mobileGrid = decl.value; }); }); });
    assert.equal(mobileGrid, '40px minmax(0, 1fr)');
});
