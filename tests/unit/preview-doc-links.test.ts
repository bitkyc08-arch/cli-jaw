// #230 — preview code-file links → manager DocPanel.
// Source-string contract tests (same style as file-links-vault-routing.test.ts):
// chat UI (public/js) and manager (public/manager) are separate bundles with no
// shared import, so the extension allowlist is drift-guarded here instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function read(relPath: string): string {
    return readFileSync(join(root, relPath), 'utf8');
}

function extractCodeReExtensions(fileLinksSrc: string): string[] {
    const match = fileLinksSrc.match(/DOC_PANEL_CODE_RE = \/\\\.\(([^)]+)\)\$\/i/);
    assert.ok(match?.[1], 'DOC_PANEL_CODE_RE must exist in file-links.ts');
    return match[1].split('|').sort();
}

function extractExtLangKeys(docPanelSrc: string): string[] {
    const match = docPanelSrc.match(/const EXT_LANG: Record<string, string> = \{([\s\S]*?)\};/);
    assert.ok(match?.[1], 'EXT_LANG must exist in DocPanel.tsx');
    return [...match[1].matchAll(/(?:^|[\s{,])([a-z]+):\s*'/g)].map((m) => m[1] as string).sort();
}

test('DOC_PANEL_CODE_RE extensions exactly mirror DocPanel EXT_LANG keys', () => {
    const fileLinks = read('public/js/render/file-links.ts');
    const docPanel = read('public/manager/src/doc-panel/DocPanel.tsx');
    assert.deepEqual(
        extractCodeReExtensions(fileLinks),
        extractExtLangKeys(docPanel),
        'allowlist drift: update DOC_PANEL_CODE_RE and EXT_LANG together',
    );
});

test('DocPanel routing is capability-gated for markdown and code files; fallback remains', () => {
    const fileLinks = read('public/js/render/file-links.ts');
    assert.ok(
        /DOC_PANEL_CODE_RE\.test\(path\) && parentSupportsDocPanel\(\)/.test(fileLinks),
        'code branch must require parent docPanel capability (browser-manager keeps Finder open)',
    );
    assert.ok(
        fileLinks.includes('/\\.(md|mdx)$/i.test(path) && parentSupportsDocPanel()'),
        'md|mdx branch must require parent docPanel capability (browser-manager keeps Finder open)',
    );
    assert.ok(fileLinks.includes('openLocalPath(path, link)'), 'openLocalPath fallback must remain');
    assert.ok(fileLinks.includes('ensurePreviewCapabilityListener()'), 'capability listener must be installed with delegation');
});

test('capability message type literal matches between sender and receiver', () => {
    const previewOrigin = read('public/js/preview-parent-origin.ts');
    const instancePreview = read('public/manager/src/InstancePreview.tsx');
    const sidebarRouter = read('public/manager/src/SidebarRailRouter.tsx');
    assert.ok(previewOrigin.includes("data.type !== 'jaw-preview-capabilities'"), 'receiver must check the capability message type');
    assert.ok(instancePreview.includes("{ type: 'jaw-preview-capabilities', docPanel }"), 'manager must send the capability message');
    assert.ok(sidebarRouter.includes('docPanelCapable={desktopPanelsAvailable}'), 'capability must follow desktopPanelsAvailable (Electron-only)');
});

test('DocPanel surfaces truncated reads instead of silent empty', () => {
    const docPanel = read('public/manager/src/doc-panel/DocPanel.tsx');
    assert.ok(docPanel.includes('result.truncated === true'), 'truncated flag must be tracked');
    assert.ok(docPanel.includes('File too large to preview'), 'truncated state must render a message');
    assert.ok(docPanel.includes("'readFile' | 'getDefaultRoot'"), 'bridge type must include getDefaultRoot for cold-start retry');
});

test('DocPanel preserves same-file scroll across async Markdown layout changes', () => {
    const docPanel = read('public/manager/src/doc-panel/DocPanel.tsx');
    const css = read('public/manager/src/doc-panel/doc-panel.css');

    assert.ok(docPanel.includes('useLayoutEffect'), 'DocPanel must restore scroll before paint after same-file content updates');
    assert.ok(docPanel.includes('scrollRef = useRef<HTMLDivElement | null>(null)'), 'DocPanel must own the scroll container ref');
    assert.ok(docPanel.includes('contentBodyRef = useRef<HTMLDivElement | null>(null)'), 'DocPanel must own an inner content body ref');
    assert.ok(docPanel.includes('className="doc-content-body"'), 'DocPanel must render an observable inner content body');
    assert.ok(docPanel.includes('new ResizeObserver'), 'DocPanel must observe async child layout changes');
    assert.ok(docPanel.includes('observer.observe(body)'), 'ResizeObserver must watch the content body, not only the fixed scroll container');
    assert.ok(docPanel.includes('activeFilePathRef.current !== filePath'), 'file changes must intentionally reset scroll');
    assert.ok(docPanel.includes('scrollSnapshotRef.current = {'), 'scroll events must keep a same-file scroll snapshot');
    assert.ok(css.includes('.doc-content-body'), 'DocPanel CSS must acknowledge the inner content body');
    assert.ok(css.includes('.doc-content .notes-mermaid-block.is-loading'), 'DocPanel CSS must scope stable Mermaid loading layout to file preview');
    assert.ok(css.includes('min-height: 96px'), 'Mermaid loading blocks must reserve stable height in DocPanel preview');
});
