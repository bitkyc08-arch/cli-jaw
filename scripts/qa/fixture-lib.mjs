// wp13 B1 — deterministic fixtures for the visual gates.
//
// Until now every gate ran against the live app on :24577, which means the
// verdict depended on how many instances happened to be running, which session
// was last selected, and whatever the sidebar had scrolled to. A gate whose
// answer changes with the machine's mood is a report.
//
// dashboard2 already ships what is needed: `dev/e2e-app-harness.tsx` replaces
// the API and SSE with a FakeApiRouter and a DeterministicSseController, and
// exposes `window.__jawE2E` for navigation. Four e2e tests already use it. This
// wires the same harness into the visual scan.
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..', '..');

/** Vite serving `public/`, so the harness module resolves the way tests expect. */
export async function startFixtureServer() {
    const { createServer } = await import('vite');
    const server = await createServer({
        configFile: join(ROOT, 'vite.config.ts'),
        root: join(ROOT, 'public'),
        logLevel: 'silent',
        server: { port: 0, host: '127.0.0.1', hmr: false },
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address !== 'object') throw new Error('vite failed to bind');
    return {
        url: `http://127.0.0.1:${address.port}/dist/dashboard2/index.html`,
        close: () => server.close(),
    };
}

/** Build the Electron preload fixture without requiring a browser. */
export function buildDesktopBridgeFixture(want, target = globalThis) {
    const scenario = want.scenario ?? 'ready';
    const sub = (register) => (handler) => {
        if (register) register(handler);
        return () => {};
    };

    let dataHandler = null;
    let exitHandler = null;
    let nextId = 1;
    const live = new Map();

    const terminalSession = (id, cwd) => ({
        id,
        shell: '/bin/zsh',
        cwd,
        cols: 80,
        rows: 24,
        port: 4242,
        seq: 1,
        buffer: 'fixture $ ',
    });

    // `restored` hydrates through list(); `ready` creates on demand;
    // `create-error` and `exited` drive the panel's failure copy.
    const seeded = scenario === 'restored' || scenario === 'exited'
        ? [terminalSession('fixture-1', '/tmp/wp5a-fixture')]
        : [];
    for (const session of seeded) live.set(session.id, session);

    const terminal = {
        list: async () => (scenario === 'list-error'
            ? { ok: false, error: 'Failed to restore terminal sessions' }
            : { ok: true, sessions: [...live.values()].map((session) => ({ ...session })) }),
        create: async ({ cwd, cols, rows, port } = {}) => {
            if (scenario === 'create-error') {
                return { ok: false, error: 'Unable to create native terminal' };
            }
            const session = terminalSession(`fixture-${nextId++}`, cwd ?? '/tmp/wp5a-fixture');
            session.cols = cols ?? session.cols;
            session.rows = rows ?? session.rows;
            if (port !== undefined) session.port = port;
            session.buffer = '';
            session.seq = 0;
            live.set(session.id, session);
            // The panel expects output to arrive through onData, not from
            // create(), so emit the way the real bridge does.
            queueMicrotask(() => dataHandler?.(session.id, 'fixture $ ', 1));
            return { ok: true, id: session.id, shell: session.shell, cwd: session.cwd };
        },
        write: async (id, data) => {
            const session = live.get(id);
            if (session) session.buffer += data;
        },
        resize: async (id, cols, rows) => {
            const session = live.get(id);
            if (session) Object.assign(session, { cols, rows });
        },
        kill: async (id) => { live.delete(id); },
        onData: sub((handler) => { dataHandler = handler; }),
        onExit: sub((handler) => { exitHandler = handler; }),
    };

    // Exit cannot be fired on subscribe. The panel binds the session id to a
    // key only after list()/create() resolves, so this remains an explicit hook.
    target.__wp5aKillTerminals = (code = 137) => {
        if (!exitHandler) return 0;
        let count = 0;
        for (const id of live.keys()) {
            exitHandler(id, code);
            count += 1;
        }
        return count;
    };

    const webviewIds = new Map();
    const browserState = (tabId, extra = {}) => ({
        tabId,
        webContentsId: webviewIds.get(tabId) ?? 1,
        url: 'https://example.invalid/',
        title: 'Fixture page',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        crashed: false,
        sharedWithAgent: false,
        ...extra,
    });
    const browserOverlay = {
        loading: { loading: true },
        shared: { sharedWithAgent: true, canGoBack: true },
        crashed: { crashed: true, error: 'Browser process crashed. Reload to retry.' },
    }[scenario] ?? {};
    const stateFor = (tabId) => browserState(tabId, browserOverlay);
    let webviewStateHandler = null;

    const browser = {
        registerWebview: async ({ tabId, webContentsId }) => {
            webviewIds.set(tabId, webContentsId);
            return { ok: true, state: stateFor(tabId) };
        },
        unregisterWebview: async ({ tabId }) => {
            webviewIds.delete(tabId);
            return { ok: true };
        },
        controlWebview: async ({ tabId }) => ({ ok: true, state: stateFor(tabId) }),
        performWebviewAction: async ({ tabId, shared }) => ({
            ok: true,
            state: browserState(tabId, { ...browserOverlay, sharedWithAgent: Boolean(shared) }),
        }),
        getWebviewTabs: async () => ({ ok: true, tabs: [] }),
        onOpenUrl: sub(),
        onElementPicked: sub(),
        onWebviewState: sub((handler) => { webviewStateHandler = handler; }),
    };

    // Electron fires `dom-ready` on a real <webview>; Chrome never creates one,
    // so expose a deterministic hook that drives the panel's real register().
    target.__wp5aArmBrowserWebview = () => {
        const element = target.document?.querySelector('.d2-browser-frame-wrap webview');
        if (!element) return false;
        element.getWebContentsId = () => 1;
        element.dispatchEvent(new target.Event('dom-ready'));
        return true;
    };
    target.__wp5aPushBrowserState = (tabId) => {
        if (!webviewStateHandler) return false;
        webviewStateHandler(stateFor(tabId));
        return true;
    };

    const diffSummaryFiles = scenario === 'diff-empty' ? [] : [
        { path: 'src/fixture.ts', status: 'modified', insertions: 2, deletions: 1 },
    ];
    const scmFiles = diffSummaryFiles.map((file) => ({
        path: file.path,
        repoRelativePath: file.path,
        kind: file.status,
        staged: false,
        unstaged: true,
        conflict: false,
    }));
    const scmSnapshot = () => ({
        repoRoot: '/tmp/wp5a-fixture',
        branch: 'dev2',
        head: '24923b6d',
        dirty: scmFiles.length > 0,
        groups: [{ id: 'changes', label: 'Changes', files: scmFiles.map((file) => ({ ...file })) }],
    });
    const diff = {
        getRepoRoot: async () => (scenario === 'diff-error'
            ? { ok: false, error: 'not a git repository' }
            : scenario === 'diff-resolving'
                // Held open so the "Resolving repository..." frame can be
                // observed. Racing it would report whatever the machine was
                // fast enough to render.
                ? new Promise(() => {})
                : { ok: true, root: '/tmp/wp5a-fixture' }),
        getRepoCandidates: async (candidates) => (scenario === 'diff-error'
            ? { ok: false, error: 'not a git repository' }
            : {
                ok: true,
                candidates: candidates.map((candidate) => ({
                    ...candidate,
                    root: '/tmp/wp5a-fixture',
                    branch: 'dev2',
                    head: '24923b6d',
                    dirty: scmFiles.length > 0,
                })),
            }),
        getScmSnapshot: async () => ({ ok: true, snapshot: scmSnapshot() }),
        runScmOperation: async (_repoRoot, operation) => ({
            ok: true,
            result: { operation: operation.kind, paths: [...operation.paths], snapshot: scmSnapshot() },
        }),
        getDiffSummary: async () => ({
            ok: true,
            files: diffSummaryFiles.map((file) => ({ ...file })),
        }),
        getFileDiff: async () => ({
            ok: true,
            diff: '--- a/src/fixture.ts\n+++ b/src/fixture.ts\n@@ -1 +1,2 @@\n-old\n+new\n+line\n',
        }),
    };

    const bridge = {
        identify: () => ({ name: 'cli-jaw-desktop', electron: true }),
        getHomePath: () => '/tmp/wp5a-fixture',
        ...(want.terminal ? { terminal } : {}),
        ...(want.diff ? { diff } : {}),
        ...(want.browser ? { browser } : {}),
    };
    target.cliJawDesktop = bridge;
    return bridge;
}

/**
 * A page running the fixture harness rather than the live app.
 *
 * `historyCount` is the only knob the surfaces need: the turn stream wants
 * enough turns to fill a viewport, everything else is happier small and fast.
 */
export async function openFixture(url, {
    historyCount = 40,
    viewport = { width: 1440, height: 900 },
    desktopBridge = null,
    autoSelectSession = true,
    initScript = null,
    initScriptArg = null,
} = {}) {
    const browser = await chromium.launch({ headless: true, channel: 'chrome' });
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();

    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

    await page.addInitScript(() => {
        Object.defineProperty(window, '__name', { configurable: true, value: (fn) => fn });
        localStorage.clear();
        sessionStorage.clear();
    });

    // Ten of the 28 tool-tab branches key off the desktop bridge, which reads
    // window.cliJawDesktop before React mounts. Injecting a stand-in is the only
    // way to reach the Electron-only halves of the terminal, browser and diff
    // panels from a plain page.
    //
    // The provider checks for specific method NAMES, so a plausible-looking stub
    // with the wrong shape silently stays unavailable and the fixture measures
    // the same fallback screen twice.
    //
    // Naming the methods is necessary but not sufficient. The first version
    // returned `undefined` from every method, which satisfied the shape check
    // and then failed inside each panel: the terminal hydrated zero sessions,
    // the browser never got a state object, and the diff panel threw reading
    // `.ok` of undefined. That is ONE failure screen per panel wearing the name
    // of ten branches. Each surface now answers with its real contract, and
    // `scenario` picks which answer, so a branch is driven rather than implied.
    if (desktopBridge) {
        await page.addInitScript(buildDesktopBridgeFixture, desktopBridge);
    }
    // A scenario may pre-seed mount-time state (e.g. the sidebar's first
    // instance/session load) before navigation.
    if (initScript) {
        await page.addInitScript(initScript, initScriptArg);
    }

    await page.route('**/dashboard2/src/main.tsx*', (route) => route.fulfill({
        contentType: 'application/javascript',
        body: `import { mountE2EAppHarness } from "/dist/dashboard2/src/dev/e2e-app-harness.tsx";`
            + ` mountE2EAppHarness(document.querySelector("#dashboard2-root"),`
            + ` { historyCount: ${historyCount}, autoSelectSession: ${autoSelectSession} });`,
    }));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // With no session the chat view never renders, so waiting for it would time
    // out on exactly the branches that need an unselected scope.
    await (autoSelectSession
        ? page.getByTestId('chat-view').waitFor({ timeout: 20_000 })
        : page.locator('.d2-shell').waitFor({ timeout: 20_000 }));

    page.consoleErrors = consoleErrors;
    return { browser, context, page };
}

/**
 * How to reach each surface in the fixture.
 *
 * Every entry ends in an assertion, not a sleep. If the surface does not
 * appear, `reach` throws and the scan records a hard failure — the old
 * `.click().catch(() => {})` turned a missing surface into a clean report.
 *
 * `scope` narrows the measured region so a parent surface does not re-measure
 * a child that has its own entry: `.d2-workbench` contains the composer and the
 * side pane, and counting those twice inflates the gate total for free.
 */
export const FIXTURE_SURFACES = {
    sidebar: {
        root: '.d2-sidebar-v4',
        reach: async (page) => { await page.locator('.d2-sidebar-v4').waitFor(); },
    },
    workbench: {
        root: '.d2-workbench',
        exclude: ['.d2-chat-composer-slot', '.d2-side-pane'],
        reach: async (page) => { await page.getByTestId('chat-view').waitFor(); },
    },
    composer: {
        root: '.d2-chat-composer-slot',
        reach: async (page) => { await page.locator('.d2-chat-composer-slot').waitFor(); },
    },
    settings: {
        root: '.d2-settings-page',
        reach: async (page) => {
            await page.evaluate(() => window.__jawE2E.setSettings());
            await page.locator('.d2-settings-page').waitFor();
        },
    },
    notes: {
        root: '.d2-notes-panel',
        reach: async (page) => {
            await page.evaluate(() => window.__jawE2E.openPanel('notes'));
            await page.locator('.d2-notes-panel').waitFor();
        },
    },
    board: {
        root: '.d2-board-panel',
        reach: async (page) => {
            await page.evaluate(() => window.__jawE2E.openPanel('board'));
            await page.locator('.d2-board-panel').waitFor();
        },
    },
    'side-pane': {
        root: '.d2-side-pane',
        exclude: ['.d2-notes-panel', '.d2-board-panel', '.d2-code-tab'],
        reach: async (page) => {
            await page.evaluate(() => window.__jawE2E.openPanel('files'));
            await page.locator('.d2-side-pane').waitFor();
        },
    },
    code: {
        root: '.d2-code-tab, .d2-code-gate',
        reach: async (page) => {
            await page.evaluate(() => window.__jawE2E.openPanel('code'));
            await page.locator('.d2-code-tab, .d2-code-gate').first().waitFor();
        },
    },
    'hover-dock': {
        root: '.hover-dock-panel',
        reach: async (page) => {
            await page.locator('.hover-dock-trigger').click();
            await page.locator('.hover-dock-panel').waitFor();
        },
    },
};

/**
 * The six tool tabs, which share the side pane but not much else.
 *
 * `side-pane` only ever measured whichever panel was open, so five of these
 * were never looked at. Each opens through the same harness call and asserts on
 * its own root, and each excludes the pane chrome so the tab bar is not
 * re-measured six times.
 */
for (const [name, root] of [
    ['terminal', '.d2-terminal-panel'],
    ['browser', '.d2-browser-panel'],
    ['files', '.d2-file-tree'],
    // Doc, design and diff render `hidden` when inactive and a second instance
    // can be open at once (a widget handoff opens its own design panel), so the
    // bare class matches two elements and the oracle's boundingBox call fails
    // in strict mode. Measure the one that is actually showing.
    ['doc', '.d2-doc-panel:not([hidden])'],
    ['design', '.d2-design-panel:not([hidden])'],
    ['diff', '.d2-diff-panel:not([hidden])'],
]) {
    FIXTURE_SURFACES[`tab-${name}`] = {
        root,
        reach: async (page) => {
            await page.evaluate((t) => window.__jawE2E.openPanel(t), name);
            await page.locator(root).waitFor({ timeout: 15_000 });
        },
    };
}

/**
 * States a surface can be in that change what the gates see.
 *
 * The default render exercises none of the 27 opacity rules in dashboard2:
 * every one keys off `:disabled`, `.is-dragging`, `.active` or a data
 * attribute. Scanning only the resting state reported "unmeasurable 0" while
 * five painted controls fade themselves the moment they are disabled.
 *
 * Each state is applied AFTER `reach` and is expected to change something; a
 * state that matches nothing is reported so the list cannot rot.
 */
/**
 * Put the browser panel into the state a real Electron webview would.
 *
 * Chrome never creates a <webview>, so `dom-ready` never fires and the panel's
 * register() — its only source of a state object — never runs. Navigating and
 * then firing that event on the element the panel already holds drives the
 * real path instead of replacing it.
 */
async function armBrowser(page) {
    await page.fill('.d2-browser-url-bar input', 'https://example.invalid/');
    await page.click('.d2-browser-url-bar button[aria-label="Go"]');
    await page.waitForFunction(() => window.__wp5aArmBrowserWebview?.() === true, null, { timeout: 5_000 });
    await page.waitForSelector('.d2-browser-agent-toggle:not([disabled])', { timeout: 5_000 });
}

export const FIXTURE_STATES = {
    default: { apply: async () => 0 },
    /**
     * The states a panel shows INSTEAD of its content.
     *
     * Every tool tab has several: the terminal alone renders unsupported,
     * prerequisite, error and loading screens, and the resting fixture shows
     * exactly one of them. Rendering the rest through React would need the whole
     * data layer faked, so the markup is substituted directly — enough to
     * measure whether the panel's own styles make these readable, which is what
     * D13 turned out to be about.
     */
    'panel-states': {
        // NOT branch coverage. This substitutes generic markup, so it answers
        // "would this panel style a status message legibly" and nothing about
        // whether any real branch renders that way. Counted separately from the
        // 28-branch ledger, which needs the component's own output.
        syntheticProbe: true,
        apply: (page, root) => page.evaluate((sel) => {
            const scope = document.querySelector(sel);
            if (!scope) return 0;
            const variants = [
                { role: 'status', text: 'Select an instance to continue' },
                { role: 'alert', text: 'Something went wrong loading this panel' },
                { role: 'status', text: 'Loading…', busy: true },
            ];
            scope.replaceChildren(...variants.map(({ role, text, busy }) => {
                const el = document.createElement('div');
                el.setAttribute('role', role);
                if (busy) el.setAttribute('aria-busy', 'true');
                el.textContent = text;
                return el;
            }));
            return variants.length;
        }, root),
    },
    /**
     * The file tree's real branches, driven through the API rather than by
     * substituting markup.
     *
     * `panel-states` answers "would this panel style a status message legibly";
     * it cannot answer "does this branch actually render that way", because it
     * replaces the component's own output. Forcing the response the component
     * reads gets the real `.d2-file-tree-message` markup, which is the thing
     * shipped to users.
     */
    'files-empty': {
        only: /file-tree/,
        // The response has to be in place BEFORE the panel mounts: an already
        // open file tree has its answer and will not ask again.
        pre: (page) => page.evaluate(() => window.__jawE2E.setFileTree({ ok: true, entries: [] })),
        apply: async (page, root) => {
            if (!root.includes('file-tree')) return 0;
            await page.locator('.d2-file-tree-message', { hasText: 'No files found' })
                .waitFor({ timeout: 5_000 });
            return 1;
        },
    },
    'files-error': {
        only: /file-tree/,
        // The response has to be in place BEFORE the panel mounts: an already
        // open file tree has its answer and will not ask again.
        //
        // `__status` is what makes this the ERROR branch. An `{ok:false}` body
        // served as 200 goes through `response.ok`, parses to zero entries and
        // renders "No files found" — the empty branch wearing an error's name.
        pre: (page) => page.evaluate(() => window.__jawE2E.setFileTree({
            __status: 500,
            ok: false,
            error: 'permission denied reading /tmp',
        })),
        apply: async (page, root) => {
            if (!root.includes('file-tree')) return 0;
            // Assert the branch, do not assume it: the panel renders the
            // transport failure verbatim, so the copy names the status.
            await page.locator('.d2-file-tree-message', { hasText: 'Unable to load files (500)' })
                .waitFor({ timeout: 5_000 });
            return 1;
        },
    },
    /**
     * The Electron-only halves of the terminal, browser and diff panels.
     *
     * Ten branches live behind the desktop bridge and a plain page never sees
     * any of them: it gets the "requires the Electron app" fallback every time.
     * The bridge has to exist before React mounts, so this is a `pre` state.
     */
    'desktop-bridge': {
        pre: null,   // handled by openFixture via the desktopBridge option
        needsBridge: { terminal: true, diff: true, browser: true },
        apply: async (page, root) => {
            if (!/terminal|browser|diff/.test(root)) return 0;
            if (root.includes('browser')) {
                // The panel only acquires a state object through its own
                // register() path, which waits for the webview's dom-ready.
                // Chrome has no <webview>, so the URL bar sat permanently
                // disabled and the branch was never really opened.
                await armBrowser(page);
            }
            await page.waitForTimeout(500);
            return 1;
        },
    },
    /**
     * The bridge-driven branches, one state per scenario.
     *
     * `desktop-bridge` above proves the panels come up on a working bridge.
     * These drive the individual ledger branches: a terminal that exits, a
     * browser that crashes, a diff with nothing to show. Each asserts its own
     * DOM, so a scenario that quietly falls back to the happy screen fails
     * rather than reporting a clean pass on the wrong branch.
     */
    ...Object.fromEntries([
        ['terminal-exited', {
            surface: /terminal/, scenario: 'exited',
            drive: async (page) => {
                await page.waitForSelector('[role="tab"]', { timeout: 5_000 });
                await page.waitForFunction(() => window.__wp5aKillTerminals?.(137) > 0, null, { timeout: 5_000 });
                await page.locator('.d2-terminal-status', { hasText: 'Terminal exited with code 137' })
                    .waitFor({ timeout: 5_000 });
                await page.locator('.d2-terminal-restart').waitFor({ timeout: 5_000 });
            },
        }],
        ['terminal-create-error', {
            surface: /terminal/, scenario: 'create-error',
            drive: async (page) => {
                await page.locator('.d2-terminal-status', { hasText: 'Unable to create native terminal' })
                    .waitFor({ timeout: 5_000 });
            },
        }],
        ['terminal-empty', {
            // Closing the last session is the only way to see the empty state:
            // the panel opens one on mount, and a failed create still leaves a
            // placeholder session behind carrying the error.
            surface: /terminal/, scenario: 'ready',
            drive: async (page) => {
                await page.locator('.d2-terminal-close').first().waitFor({ timeout: 5_000 });
                for (const close of await page.locator('.d2-terminal-close').all()) {
                    await close.click();
                }
                await page.locator('.d2-terminal-empty', { hasText: 'No terminal sessions' })
                    .waitFor({ timeout: 5_000 });
            },
        }],
        ['browser-loading', {
            surface: /browser/, scenario: 'loading',
            drive: async (page) => {
                await armBrowser(page);
                await page.locator('.d2-browser-loading').waitFor({ timeout: 5_000 });
            },
        }],
        ['browser-crashed', {
            surface: /browser/, scenario: 'crashed',
            drive: async (page) => {
                await armBrowser(page);
                await page.locator('.d2-browser-panel [role="alert"]', { hasText: 'Browser process crashed' })
                    .waitFor({ timeout: 5_000 });
            },
        }],
        ['browser-shared', {
            surface: /browser/, scenario: 'shared',
            drive: async (page) => {
                await armBrowser(page);
                await page.locator('.d2-browser-agent-toggle[data-shared="true"]').waitFor({ timeout: 5_000 });
            },
        }],
        ['diff-empty', {
            surface: /diff/, scenario: 'diff-empty',
            drive: async (page) => {
                await page.locator('.d2-diff-panel', { hasText: 'No unstaged changes' })
                    .waitFor({ timeout: 8_000 });
            },
        }],
        ['diff-error', {
            surface: /diff/, scenario: 'diff-error',
            drive: async (page) => {
                await page.locator('.d2-diff-panel', { hasText: 'not a git repository' })
                    .waitFor({ timeout: 8_000 });
            },
        }],
    ].map(([name, spec]) => [name, {
        pre: null,
        needsBridge: { terminal: true, diff: true, browser: true, scenario: spec.scenario },
        only: spec.surface,
        apply: async (page, root) => {
            if (!spec.surface.test(root)) return 0;
            await spec.drive(page);
            return 1;
        },
    }])),
    /**
     * Doc and Design read their entire state from the panel payload, so the
     * default fixture could only ever show their empty screens. `panelPayload`
     * reopens the tab with a payload the app itself can produce.
     */
    ...Object.fromEntries([
        ['doc-truncated', { type: 'doc', surface: /doc-panel/, payload: {
            path: '/tmp/wp5a-fixture/notes.md', content: '# Fixture\n\nTruncated body.', truncated: true,
        }, expect: 'Truncated preview' }],
        ['doc-binary', { type: 'doc', surface: /doc-panel/, payload: {
            path: '/tmp/wp5a-fixture/logo.png', content: '', binary: true,
        }, expect: 'Binary preview is not supported' }],
        ['doc-ready', { type: 'doc', surface: /doc-panel/, payload: {
            path: '/tmp/wp5a-fixture/readme.md', content: '# Fixture document\n\nBody copy.',
        }, expect: 'Fixture document' }],
        ['design-url', { type: 'design', surface: /design-panel/, payload: {
            // A same-origin page. An external URL loads a cross-origin document
            // whose own localStorage access throws, and the gate correctly
            // reported that as a console error against this panel.
            kind: 'url', url: 'about:blank',
        }, expect: null }],
    ].map(([name, spec]) => [name, {
        pre: null,
        only: spec.surface,
        // Reopening with a payload replaces the panel instance, so this has to
        // happen after the tab exists, not before it.
        apply: async (page, root) => {
            if (!spec.surface.test(root)) return 0;
            await page.evaluate(([type, payload]) => {
                window.__jawE2E.openPanel(type, false, payload);
            }, [spec.type, spec.payload]);
            if (spec.expect) {
                await page.locator(root, { hasText: spec.expect }).waitFor({ timeout: 5_000 });
            } else {
                await page.locator(`${root} iframe`).waitFor({ timeout: 5_000 });
            }
            return 1;
        },
    }])),
    /** The file tree's remaining two branches: 404 and a failed file open. */
    'files-unavailable': {
        only: /file-tree/,
        pre: (page) => page.evaluate(() => window.__jawE2E.setFileTree({ __status: 404, ok: false })),
        apply: async (page, root) => {
            if (!root.includes('file-tree')) return 0;
            await page.locator('.d2-file-tree-message', { hasText: 'File browser coming soon' })
                .waitFor({ timeout: 5_000 });
            return 1;
        },
    },
    /**
     * A file that fails to open, which is a different branch from a directory
     * listing that fails: it renders inside the populated tree, as an alert
     * with a Retry beside the rows that are still there.
     */
    'files-open-error': {
        only: /file-tree/,
        pre: null,
        apply: async (page, root) => {
            if (!root.includes('file-tree')) return 0;
            await page.locator('.d2-file-tree [role="treeitem"]').first().waitFor({ timeout: 5_000 });
            await page.locator('.d2-file-tree [role="treeitem"]').first().click();
            await page.locator('.d2-file-tree-message[role="alert"]').waitFor({ timeout: 5_000 });
            return 1;
        },
    },
    /**
     * No session selected.
     *
     * Files is the only tool tab that opens without one — terminal, code and
     * diff are `needsSession`, so SidePane answers for them with its own
     * placeholder and their port-null branches never run (see the reachability
     * audit in tab-state-ledger.mjs).
     */
    'no-session': {
        only: /file-tree/,
        pre: null,
        noSession: true,
        apply: async (page, root) => {
            if (!root.includes('file-tree')) return 0;
            await page.locator('.d2-file-tree-message', { hasText: 'Select an instance to browse files' })
                .waitFor({ timeout: 5_000 });
            return 1;
        },
    },
    /**
     * The terminal's own loading frame, which lasts exactly as long as the
     * instance lookup that supplies its working directory. Holding that request
     * open is the only way to see it; a timing race would report whatever the
     * machine happened to be fast enough to render.
     */
    'terminal-cwd-loading': {
        only: /terminal/,
        pre: (page) => page.evaluate(() => window.__jawE2E.setHoldInstances(true)),
        needsBridge: { terminal: true, diff: true, browser: true },
        apply: async (page, root) => {
            if (!root.includes('terminal')) return 0;
            await page.locator('.d2-terminal-panel.is-state[aria-busy="true"]',
                { hasText: 'Loading terminal working directory' }).waitFor({ timeout: 5_000 });
            return 1;
        },
    },
    /** An instance the server knows about but that reports no working directory. */
    'terminal-cwd-error': {
        only: /terminal/,
        pre: (page) => page.evaluate(() => window.__jawE2E.setDropWorkingDir(true)),
        needsBridge: { terminal: true, diff: true, browser: true },
        apply: async (page, root) => {
            if (!root.includes('terminal')) return 0;
            await page.locator('.d2-terminal-panel.is-state[role="alert"]',
                { hasText: 'No working directory for this instance' }).waitFor({ timeout: 5_000 });
            return 1;
        },
    },
    /**
     * Electron with no browser surface on the bridge.
     *
     * Distinct from the plain web page: the environment says Electron, so the
     * panel takes the desktop path and finds nothing wired, which is its own
     * "Desktop browser unavailable" branch.
     */
    'browser-bridge-missing': {
        only: /browser/,
        pre: null,
        needsBridge: { terminal: true, diff: true, browser: false },
        apply: async (page, root) => {
            if (!root.includes('browser')) return 0;
            await page.locator('.d2-browser-panel [role="alert"]',
                { hasText: 'Desktop browser unavailable' }).waitFor({ timeout: 5_000 });
            return 1;
        },
    },
    /** The Electron browser before any navigation: no webview, empty prompt. */
    'browser-idle': {
        only: /browser/,
        pre: null,
        needsBridge: { terminal: true, diff: true, browser: true },
        apply: async (page, root) => {
            if (!root.includes('browser')) return 0;
            await page.locator('.d2-browser-agent-toggle').waitFor({ timeout: 5_000 });
            await page.locator('.d2-browser-empty',
                { hasText: 'Enter a URL to start browsing' }).waitFor({ timeout: 5_000 });
            return 1;
        },
    },
    /** The file tree while its first directory read is still in flight. */
    'files-loading': {
        only: /file-tree/,
        pre: (page) => page.evaluate(() => window.__jawE2E.setFileTree({ __hold: true })),
        apply: async (page, root) => {
            if (!root.includes('file-tree')) return 0;
            await page.locator('.d2-file-tree-message[role="status"]',
                { hasText: 'Loading files' }).waitFor({ timeout: 5_000 });
            return 1;
        },
    },
    /** The diff panel while it is still resolving the repository root. */
    'diff-resolving': {
        only: /diff/,
        pre: null,
        needsBridge: { terminal: true, diff: true, browser: true, scenario: 'diff-resolving' },
        apply: async (page, root) => {
            if (!root.includes('diff')) return 0;
            await page.locator('.d2-diff-panel .d2-panel-state[role="status"]',
                { hasText: 'Resolving repository' }).waitFor({ timeout: 8_000 });
            return 1;
        },
    },
    /** A design panel handed a widget that has not been promoted yet. */
    'design-widget-pending': {
        only: /design-panel/,
        pre: null,
        apply: async (page, root) => {
            if (!root.includes('design-panel')) return 0;
            // The payload is validated hard: `source` must be 'turn-widget',
            // the descriptor must be complete, and panelKey/rowKey must be the
            // values derived from chatId, widgetId and identity. A plausible
            // object is rejected and the panel silently shows its empty state,
            // which is how a looser version of this passed while proving
            // nothing. Derived here exactly as widget-panel-key.ts derives them.
            await page.evaluate(() => {
                const chatId = 'wp5a';
                const widgetId = 'fixture-widget';
                const identity = { scopeKey: 'wp5a-scope', turnId: 'turn-1', segmentId: 'seg-1' };
                const enc = encodeURIComponent;
                const payload = {
                    kind: 'widget',
                    source: 'turn-widget',
                    panelKey: `widget:${enc(chatId)}:${enc(widgetId)}`,
                    rowKey: `widget-row:${enc(identity.scopeKey)}:${enc(identity.turnId)}:${enc(identity.segmentId)}`,
                    chatId,
                    descriptor: {
                        widgetId,
                        title: 'Fixture widget',
                        revision: '1',
                        storage: 'inline',
                        source: '<div>fixture</div>',
                        estimatedHeight: 240,
                        capabilities: ['stateful'],
                    },
                    identity,
                };
                // SidePane forwards the payload only when key === panelKey.
                window.__jawE2E.openPanel('design', false, payload, payload.panelKey);
            });
            await page.locator('.d2-design-panel .d2-panel-state',
                { hasText: 'Preparing widget panel' }).waitFor({ timeout: 5_000 });
            return 1;
        },
    },
    disabled: {
        // Not a React branch: this flips `disabled` on whatever is already in
        // the DOM, so the panel keeps showing the state it was in. It cannot be
        // confused with a branch and the negative matrix skips it.
        syntheticProbe: true,
        apply: (page, root) => page.evaluate((sel) => {
            const scope = document.querySelector(sel);
            if (!scope) return 0;
            const controls = [...scope.querySelectorAll('button, input, select, textarea')];
            for (const c of controls) c.disabled = true;
            return controls.length;
        }, root),
    },
    dragging: {
        // Also synthetic: it marks existing elements as being dragged.
        syntheticProbe: true,
        apply: (page, root) => page.evaluate((sel) => {
            const scope = document.querySelector(sel);
            if (!scope) return 0;
            let n = 0;
            for (const card of scope.querySelectorAll('.d2-board-card, .d2-reminders-card')) {
                card.classList.add('is-dragging');
                card.setAttribute('data-dragging', 'true');
                n += 1;
            }
            return n;
        }, root),
    },
    busy: {
        apply: (page, root) => page.evaluate((sel) => {
            const scope = document.querySelector(sel);
            if (!scope) return 0;
            let n = 0;
            // The shimmer is real gradient text and must be measured, or at
            // least reported as unmeasurable, rather than never rendered.
            for (const el of scope.querySelectorAll('.d2-tool-line, .d2-segment-toggle')) {
                el.classList.add('d2-turn-shimmer', 'is-running');
                n += 1;
            }
            return n;
        }, root),
    },
};
