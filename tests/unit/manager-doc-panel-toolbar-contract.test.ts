import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(root, path), 'utf8');
}

test('DocPanel toolbar exposes Raw, Path, and Copy actions', () => {
    const panel = read('public/manager/src/doc-panel/DocPanel.tsx');
    const css = read('public/manager/src/doc-panel/doc-panel.css');

    assert.ok(panel.includes("import { copyText } from '../clipboard/copy-text';"), 'DocPanel must use the shared clipboard helper');
    assert.ok(panel.includes("const [raw, setRaw] = useState(false)"), 'DocPanel must own raw preview state');
    assert.ok(panel.includes("const [copiedAction, setCopiedAction] = useState<'path' | 'content' | null>(null)"), 'DocPanel must track Path/Copy feedback separately');
    assert.ok(panel.includes('className="doc-toolbar-actions"'), 'DocPanel toolbar must group document actions');
    assert.ok(panel.includes('aria-label="Document actions"'), 'DocPanel action group must be named for accessibility');
    assert.ok(panel.includes('aria-pressed={raw}'), 'Raw must expose toggle state');
    assert.ok(panel.includes('title="Show raw source"'), 'Raw action must be explicit');
    assert.ok(panel.includes('title="Copy full path"'), 'Path action must keep full-path copy behavior');
    assert.ok(panel.includes('title="Copy file content"'), 'Copy action must copy file content');
    assert.ok(panel.includes("{copiedAction === 'path' ? 'Copied' : 'Path'}"), 'Path button must show independent copy feedback');
    assert.ok(panel.includes("{copiedAction === 'content' ? 'Copied' : 'Copy'}"), 'Copy button must show independent copy feedback');
    assert.ok(panel.includes('<DocContent filePath={props.filePath} content={content} raw={raw} />'), 'Raw state must control document rendering');
    assert.equal(panel.includes('document.querySelector'), false, 'DocPanel toolbar must not mutate button text through global DOM queries');
    assert.equal(panel.includes('navigator.clipboard.writeText'), false, 'DocPanel toolbar must route clipboard writes through copyText');

    assert.ok(css.includes('.doc-toolbar-actions'), 'DocPanel CSS must style the action group');
    assert.ok(css.includes('.doc-toolbar-button'), 'DocPanel CSS must style the three action buttons');
    assert.ok(css.includes('.doc-toolbar-button.is-active'), 'DocPanel CSS must visibly mark Raw when active');
    assert.equal(css.includes('.doc-copy-path'), false, 'obsolete single Path button class must be removed');
});
