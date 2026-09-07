import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import type { ComponentProps, ReactNode } from 'react';
import { JSDOM } from 'jsdom';
import type { DashboardInstance } from '../../public/manager/src/types';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://sidebar.test/' });
const replacements = {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
    // Imported Manager TSX uses classic JSX under the root test runner.
    React: await import('react'),
};
const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { act, createElement, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { InstanceRow } = await import('../../public/manager/src/components/InstanceRow');
const { InstanceNavigator } = await import('../../public/manager/src/components/InstanceNavigator');
const { InstanceGroups } = await import('../../public/manager/src/components/InstanceGroups');

after(() => {
    dom.window.close();
    for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});

function instance(port: number, overrides: Partial<DashboardInstance> = {}): DashboardInstance {
    return {
        port, label: `Workspace ${port}`, url: `https://instance.test/${port}`, status: 'online', ok: true,
        version: '2.0.0', uptime: 60, instanceId: `instance-${port}`, homeDisplay: '/fixture/home',
        workingDir: '/fixture/project', projectDirs: ['/fixture/project'], currentCli: 'codex', currentModel: 'fixture-model',
        serviceMode: 'ad-hoc', lastCheckedAt: '2026-09-08T00:00:00Z', healthReason: null,
        lifecycle: {
            owner: 'manager', canStart: false, canStop: true, canRestart: true, canPerm: true, canUnperm: false,
            reason: 'ok', defaultHome: '/fixture/home', commandPreview: [], pid: 123,
        },
        ...overrides,
    };
}

async function mount(t: TestContext, element: ReactNode) {
    const container = dom.window.document.createElement('div');
    container.className = 'manager-sidebar';
    dom.window.document.body.append(container);
    const root = createRoot(container);
    t.after(async () => {
        await act(async () => root.unmount());
        container.remove();
        dom.window.localStorage.clear();
    });
    const render = async (next: ReactNode) => { await act(async () => root.render(next)); };
    await render(element);
    const get = <T extends HTMLElement = HTMLElement>(selector: string): T => {
        const node = container.querySelector<T>(selector);
        assert.ok(node, `Missing mounted control: ${selector}`);
        return node;
    };
    return { container, render, get };
}

async function key(target: HTMLElement, value: string, init: KeyboardEventInit = {}) {
    target.focus();
    const event = new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init });
    await act(async () => { target.dispatchEvent(event); });
    return event;
}

function rowProps(t: TestContext, value = instance(3457)): ComponentProps<typeof InstanceRow> {
    return {
        instance: value, selected: true, busy: false, label: value.label!, uptime: '1m', priority: 'active',
        activityUnreadCount: 2, sessionCount: 2, sessionsOpen: false,
        onSelect: t.mock.fn(), onPreview: t.mock.fn(), onMarkActivitySeen: t.mock.fn(),
        onInstanceLabelSave: t.mock.fn(async () => {}), onLifecycle: t.mock.fn(), onToggleSessions: t.mock.fn(),
    };
}

function navigator(children: ReactNode, onSelectPort: (port: number) => void) {
    return createElement(InstanceNavigator, {
        active: instance(3457), hiddenCount: 0, collapsed: false, query: '', onQueryChange: () => {}, onSelectPort, children,
    });
}

test('mounted row uses sibling selection/actions and phrasing-only selection content', async t => {
    const props = rowProps(t);
    const view = await mount(t, navigator(createElement(InstanceRow, props), () => {}));
    const select = view.get<HTMLButtonElement>('.instance-row-select');
    const quick = view.get('.instance-row-quick');
    assert.equal(select.parentElement, quick.parentElement);
    assert.equal(select.parentElement?.className, 'instance-row-body');
    assert.equal(select.querySelector('button, a, input, [role="button"], [tabindex]'), null);
    assert.ok([...select.querySelectorAll('*')].every(node => ['SPAN', 'STRONG', 'EM'].includes(node.tagName)));
    assert.equal(view.container.querySelectorAll('[data-instance-port]').length, 1);
    for (const name of ['main', 'title', 'title-line', 'status-line', 'meta']) {
        assert.equal(view.get(`.instance-row-${name}`).tagName, 'SPAN');
    }
    assert.equal(view.get('.instance-row-title-line strong').textContent, 'Workspace 3457');
    assert.equal(view.get('.instance-row-status-pill').textContent, 'Online');
    assert.equal(view.get('.instance-unread-badge').getAttribute('aria-label'), '2 unread activity');
    assert.match(view.get('article').title, /\/fixture\/home/);
    assert.equal(view.get('.instance-navigator-header strong').textContent, 'Instances');
    assert.doesNotMatch(view.get('.instance-navigator-header').textContent ?? '', /0 hidden|:3457/);
});

test('row Enter selects once; action Enter stays native and invokes only that action on click', async t => {
    const selected = t.mock.fn<(value: DashboardInstance) => void>();
    const lifecycle = t.mock.fn();
    const disclosure = t.mock.fn();
    const seen = t.mock.fn();
    const props = { ...rowProps(t), onSelect: selected, onLifecycle: lifecycle, onToggleSessions: disclosure, onMarkActivitySeen: seen };
    const view = await mount(t, navigator(createElement(InstanceRow, props), port => {
        assert.equal(port, props.instance.port);
        selected(props.instance);
    }));
    const select = view.get<HTMLButtonElement>('.instance-row-select');
    const enter = await key(select, 'Enter');
    assert.equal(enter.defaultPrevented, true);
    // JSDOM does not synthesize native keyboard clicks. Model the browser default
    // only if unhandled, so a selection key cannot also trigger the click path.
    if (!enter.defaultPrevented) await act(async () => select.click());
    assert.deepEqual(selected.mock.calls.map(call => call.arguments), [[props.instance]]);
    selected.mock.resetCalls();
    for (const selector of ['.action-stop', '.action-sessions', '.action-open']) {
        const action = view.get(selector);
        assert.equal((await key(action, 'Enter')).defaultPrevented, false);
        await act(async () => {
            // Block navigation; React still receives the action click.
            const preventNavigation = (event: Event) => event.preventDefault();
            action.addEventListener('click', preventNavigation, { once: true });
            action.click();
            action.removeEventListener('click', preventNavigation);
        });
        assert.equal(selected.mock.callCount(), 0);
    }
    assert.deepEqual(lifecycle.mock.calls.map(call => call.arguments), [['stop', props.instance]]);
    assert.deepEqual(disclosure.mock.calls.map(call => call.arguments), [[3457]]);
    assert.deepEqual(seen.mock.calls.map(call => call.arguments), [[3457]]);
    const open = view.get<HTMLAnchorElement>('.action-open');
    assert.equal(open.href, props.instance.url);
    assert.equal(open.target, '_blank');
    assert.equal(open.rel, 'noreferrer');
    await act(async () => select.click());
    assert.deepEqual(selected.mock.calls.map(call => call.arguments), [[props.instance]]);
});

test('row navigation moves focus only, while rename and action controls retain Home/End/arrows', async t => {
    const select = t.mock.fn();
    const lifecycle = t.mock.fn();
    const props = { ...rowProps(t), onSelect: select, onLifecycle: lifecycle };
    const view = await mount(t, navigator([
        createElement(InstanceRow, { ...props, key: 3457 }),
        createElement(InstanceRow, { ...rowProps(t, instance(3458)), key: 3458, onSelect: select, onLifecycle: lifecycle }),
    ], select));
    const first = view.get('[data-instance-port="3457"]');
    const second = view.get('[data-instance-port="3458"]');
    for (const [from, name, to] of [[first, 'ArrowDown', second], [second, 'ArrowUp', first], [first, 'End', second], [second, 'Home', first]] as const) {
        assert.equal((await key(from, name)).defaultPrevented, true);
        assert.equal(dom.window.document.activeElement, to);
    }
    await act(async () => view.get('.instance-label-edit-button').click());
    const input = view.get<HTMLInputElement>('.instance-label-input');
    for (const name of ['Home', 'End', 'ArrowDown', 'ArrowUp']) {
        assert.equal((await key(input, name)).defaultPrevented, false);
        assert.equal(dom.window.document.activeElement, input);
        assert.equal(input.value, 'Workspace 3457');
    }
    for (const selector of ['.action-stop', '.action-sessions', '.action-open', '.instance-label-save']) {
        const control = view.get(selector);
        for (const name of ['Home', 'End', 'ArrowDown', 'ArrowUp']) {
            assert.equal((await key(control, name)).defaultPrevented, false);
            assert.equal(dom.window.document.activeElement, control);
        }
    }
    assert.equal((await key(first, 'Enter', { isComposing: true })).defaultPrevented, false);
    assert.equal((await key(first, 'End', { keyCode: 229 })).defaultPrevented, false);
    assert.equal(select.mock.callCount(), 0);
    assert.equal(lifecycle.mock.callCount(), 0);
});

test('offline and busy row actions keep their disabled contracts without selecting', async t => {
    const selected = t.mock.fn();
    const lifecycle = t.mock.fn();
    const seen = t.mock.fn();
    const props = { ...rowProps(t, instance(3457, { ok: false, status: 'offline' })), busy: true, onSelect: selected, onLifecycle: lifecycle, onMarkActivitySeen: seen };
    const view = await mount(t, navigator(createElement(InstanceRow, props), selected));
    const stop = view.get<HTMLButtonElement>('.action-stop');
    const open = view.get<HTMLAnchorElement>('.action-open');
    assert.equal(stop.disabled, true);
    assert.equal(view.container.querySelector('.action-sessions'), null);
    assert.equal(open.getAttribute('href'), null);
    assert.equal(open.getAttribute('target'), null);
    assert.equal(open.getAttribute('rel'), null);
    assert.equal(open.getAttribute('aria-disabled'), 'true');
    assert.equal(open.tabIndex, -1);
    await act(async () => { stop.click(); open.click(); });
    assert.equal(selected.mock.callCount(), 0);
    assert.equal(lifecycle.mock.callCount(), 0);
    assert.equal(seen.mock.callCount(), 0);
});

test('Selected summary retains group identity, session linkage while closed, and lifecycle grouping/paging', async t => {
    const values = [instance(3457), instance(3458), ...Array.from({ length: 12 }, (_, i) => instance(3500 + i, { ok: false, status: 'offline' }))];
    const selected = t.mock.fn();
    const lifecycle = t.mock.fn();
    const disclosure = t.mock.fn();
    function GroupsFixture({ port }: { port: number }) {
        const [open, setOpen] = useState(false);
        return createElement(InstanceGroups, {
            instances: values, selectedPort: port, lifecycleBusyPort: null,
            getLabel: value => value.label!, formatUptime: () => '1m',
            onSelect: selected, onLifecycle: lifecycle, onPreview: () => {}, onMarkActivitySeen: () => {},
            onInstanceLabelSave: async () => {}, activeSessionCount: 2, activeSessionsOpen: open,
            onToggleActiveSessions: target => { disclosure(target); setOpen(value => !value); },
            renderActiveSessionList: target => open ? createElement('div', { className: 'instance-session-list' }, `Sessions for ${target}`) : null,
        });
    }
    const view = await mount(t, navigator(createElement(GroupsFixture, { port: 3457 }), selected));
    const summary = view.get('[aria-label="Selected instances"]');
    assert.equal(summary.querySelector('[id="instance-group-body-active"]') != null, true);
    assert.equal(summary.querySelectorAll('[data-instance-port="3457"]').length, 1);
    assert.equal(view.container.querySelectorAll('[data-instance-port="3457"]').length, 2);
    const disclosureButton = view.get<HTMLButtonElement>('[aria-label="Selected instances"] .action-sessions');
    assert.equal(disclosureButton.getAttribute('aria-controls'), 'instance-sessions-3457');
    const wrapper = view.get('#instance-sessions-3457');
    assert.equal(wrapper.childElementCount, 0);
    assert.equal(disclosureButton.getAttribute('aria-expanded'), 'false');
    await act(async () => disclosureButton.click());
    assert.equal(disclosureButton.getAttribute('aria-expanded'), 'true');
    assert.equal(wrapper.textContent, 'Sessions for 3457');
    await act(async () => disclosureButton.click());
    assert.equal(view.get('#instance-sessions-3457'), wrapper);
    assert.equal(wrapper.childElementCount, 0);
    await view.render(navigator(createElement(GroupsFixture, { port: 3458 }), selected));
    const next = view.get<HTMLButtonElement>('[aria-label="Selected instances"] .action-sessions');
    assert.equal(next.getAttribute('aria-controls'), 'instance-sessions-3458');
    assert.ok(view.get('#instance-sessions-3458'));
    assert.equal(view.container.querySelector('#instance-sessions-3457'), null);
    await act(async () => next.click());
    assert.equal(view.get('#instance-sessions-3458').textContent, 'Sessions for 3458');
    assert.deepEqual(disclosure.mock.calls.map(call => call.arguments), [[3457], [3457], [3458]]);
    await act(async () => view.get('[aria-label="Running instances"] .instance-group-toggle').click());
    assert.equal(view.get('#instance-group-body-running').querySelectorAll('[data-instance-port]').length, 1);
    assert.ok(view.get('#instance-group-body-running [data-instance-port="3458"]'));
    assert.equal(view.get('#instance-group-body-settled').querySelectorAll('[data-instance-port]').length, 10);
    await act(async () => view.get('.instance-settled-more').click());
    assert.equal(view.get('#instance-group-body-settled').querySelectorAll('[data-instance-port]').length, 12);
    assert.equal(view.container.querySelector('.instance-settled-more'), null);
    assert.equal(selected.mock.callCount(), 0);
    assert.equal(lifecycle.mock.callCount(), 0);
});
