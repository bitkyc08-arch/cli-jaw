import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(root, path), 'utf8');
}

test('Browser panel is an interactive Manager panel, not Browser QA or Code transcript state', () => {
    const browserPanel = read('public/manager/src/browser-panel/BrowserPanel.tsx');
    const panelCapabilities = read('public/manager/src/panels/panel-capabilities.ts');
    const router = read('public/manager/src/SidebarRailRouter.tsx');
    const codeWorkbench = read('public/manager/src/code/CodeWorkbench.tsx');

    assert.match(browserPanel, /createElement\('webview'/, 'Electron BrowserPanel must render an embedded webview');
    assert.match(browserPanel, /partition: 'persist:cli-jaw-browser'/, 'BrowserPanel must keep a browser-specific partition');
    assert.match(browserPanel, /getDesktop\(\)\?\.browser\?\.onOpenUrl/, 'BrowserPanel may consume desktop browser open-url events');
    assert.match(panelCapabilities, /browser: capability\('browser', 'enabled'\)/, 'browser panel must be enabled for the Electron Manager surface');
    assert.match(panelCapabilities, /browser: capability\('browser', 'disabled', 'Browser side panel is available in the desktop app\.'\)/, 'browser panel must be disabled for the web Manager surface');
    assert.match(router, /case 'browser': return <Suspense fallback=\{fallback\}><BrowserPanel/, 'BrowserPanel must mount through panel routing');

    assert.doesNotMatch(browserPanel, /\/api\/bgtask\b|BackgroundTaskMonitor|web-ai session|session-status/, 'BrowserPanel must not own web-ai background task state');
    assert.doesNotMatch(browserPanel, /\/api\/code\b|CodeCanvas|CodeWorkbench|CodeSession|CodeTranscript/, 'BrowserPanel must not own Code mode session or transcript state');
    assert.doesNotMatch(browserPanel, /\/api\/browser\/(?:snapshot|screenshot|act|web-ai|text|dom|network)\b/, 'BrowserPanel must not be the Browser QA automation client');
    assert.doesNotMatch(codeWorkbench, /BrowserPanel|browser-webview|onOpenUrl/, 'Code workbench must not embed BrowserPanel state in Code mode');
});

test('web-ai long work is observed through background tasks, not BrowserPanel state', () => {
    const backgroundPanel = read('public/manager/src/background-tasks/BackgroundTaskMonitorPanel.tsx');
    const backgroundHook = read('public/manager/src/background-tasks/useBackgroundTasks.ts');
    const backgroundClient = read('public/manager/src/background-tasks/background-task-client.ts');
    const bgtaskPreset = read('src/bgtask/presets.ts');
    const bgtaskRunner = read('src/bgtask/runner.ts');
    const browserRoutes = read('src/routes/browser.ts');
    const bgtaskRoutes = read('src/routes/bgtask.ts');

    assert.match(backgroundPanel, /BrowserPanel state and Code transcript stay separate\./, 'web-ai monitor copy must preserve BrowserPanel/Code transcript separation');
    assert.match(backgroundHook, /task\.kind === 'web-ai' && task\.spec\.completion\.type === 'session-status'/, 'web-ai retry must detect session-status rows');
    assert.match(backgroundHook, /preset: 'web-ai'/, 'web-ai retry must recreate via the web-ai preset');
    assert.match(backgroundClient, /\/api\/bgtask/, 'background monitor client must use Manager /api/bgtask');
    assert.match(backgroundClient, /\/api\/events/, 'background monitor must observe multiplexed Manager events');
    assert.match(bgtaskPreset, /completion: \{ type: 'session-status', sessionId \}/, 'web-ai preset must build a read-only session-status probe');
    assert.match(bgtaskPreset, /resultExtractor: \{ type: 'session-answer' \}/, 'web-ai preset must extract the native web-ai answer');
    assert.match(bgtaskPreset, /import\('\.\.\/browser\/web-ai\/session\.js'\)/, 'web-ai preset must read native web-ai session state');
    assert.match(bgtaskRunner, /probe mode \(web-ai session-status\)/, 'bgtask runner must keep web-ai observation in probe mode');
    assert.match(browserRoutes, /\/api\/browser\/web-ai\/watch/, 'Browser QA/web-ai route owns browser automation watch endpoints');
    assert.match(bgtaskRoutes, /body\['preset'\] === 'web-ai'/, 'bgtask route owns durable web-ai preset registration');

    assert.doesNotMatch(backgroundPanel, /import .*BrowserPanel|<BrowserPanel|browser-webview|onOpenUrl/, 'background monitor must not embed BrowserPanel');
    assert.doesNotMatch(backgroundClient, /\/api\/code\b|selectedInstance|3465/, 'background monitor client must not depend on Code APIs or child Jaw instances');
    assert.doesNotMatch(bgtaskPreset, /BrowserPanel|browser-webview|\/api\/code\b/, 'web-ai preset must not couple to BrowserPanel or Code routes');
});
