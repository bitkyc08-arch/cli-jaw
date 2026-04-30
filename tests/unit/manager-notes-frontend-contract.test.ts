import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(projectRoot, path), 'utf8');
}

test('Notes workspace frontend files and API wrapper exist', () => {
    [
        'public/manager/src/notes/NotesWorkspace.tsx',
        'public/manager/src/notes/NotesSidebar.tsx',
        'public/manager/src/notes/NotesFileTree.tsx',
        'public/manager/src/notes/NotesToolbar.tsx',
        'public/manager/src/notes/NotesEmptyState.tsx',
        'public/manager/src/notes/useNoteDocument.ts',
        'public/manager/src/notes/notes-api.ts',
        'public/manager/src/manager-notes.css',
    ].forEach(path => {
        assert.equal(existsSync(join(projectRoot, path)), true, `${path} must exist`);
    });

    const api = read('public/manager/src/notes/notes-api.ts');
    assert.ok(api.includes('fetchNotesTree'), 'notes API wrapper must re-export tree fetch');
    assert.ok(api.includes('fetchNoteFile'), 'notes API wrapper must re-export file fetch');
    assert.ok(api.includes('saveNoteFile'), 'notes API wrapper must re-export file save');
});

test('Notes API and create actions surface backend/fallback failures without uncaught JSON parse crashes', () => {
    const api = read('public/manager/src/api.ts');
    const sidebar = read('public/manager/src/notes/NotesSidebar.tsx');
    const tree = read('public/manager/src/notes/NotesFileTree.tsx');
    const workspace = read('public/manager/src/notes/NotesWorkspace.tsx');

    assert.ok(api.includes('response.text()'), 'notes response parsing must inspect text before JSON parsing');
    assert.ok(api.includes('invalid_json'), 'notes response parsing must classify non-JSON responses');
    assert.ok(api.includes('DashboardApiError'), 'notes response parsing must surface typed API errors');
    assert.ok(sidebar.includes('async function createNote()'), 'notes sidebar must own create note action');
    assert.ok(sidebar.includes('async function createFolder()'), 'notes sidebar must own create folder action');
    assert.ok(sidebar.includes('catch (err)'), 'notes sidebar create actions must catch async API failures');
    assert.ok(sidebar.includes('setError((err as Error).message)'), 'notes sidebar create failures must render as tree errors');
    assert.ok(sidebar.includes('function hasFile('), 'notes sidebar must verify registry-selected note paths against the current tree');
    assert.ok(sidebar.includes('props.onSelectedPathChange(nextSelected)'), 'notes sidebar must clear stale selected paths when the tree does not contain them');
    assert.ok(sidebar.includes('selectedFolderPath'), 'notes sidebar must track the selected folder for nested note/folder creation');
    assert.ok(sidebar.includes('createNoteFolder(name)'), 'notes sidebar must call the folder creation API');
    assert.ok(sidebar.includes('renameNotePath'), 'notes sidebar must use notes rename API for drag-to-folder moves');
    assert.ok(sidebar.includes('function movePathToFolder('), 'notes sidebar must derive the moved file path from the target folder');
    assert.ok(sidebar.includes('async function moveNote('), 'notes sidebar must own drag move error handling');
    assert.ok(sidebar.includes('function rebasePath('), 'notes sidebar must rebase selected paths after folder renames');
    assert.ok(sidebar.includes('function pathName('), 'notes sidebar must derive compact basename defaults for rename prompts');
    assert.ok(sidebar.includes('function renameTarget('), 'notes sidebar must preserve the current parent folder for basename-only renames');
    assert.ok(sidebar.includes('async function renamePath('), 'notes sidebar must own file and folder rename error handling');
    assert.ok(sidebar.includes("kind === 'folder' ? 'Rename folder' : 'Rename note'"), 'notes sidebar must prompt for the correct rename target type');
    assert.ok(sidebar.includes('window.prompt(label, pathName(path))'), 'rename prompts must show only the item name by default');
    assert.ok(sidebar.includes("parent ? `${parent}/${nextName}` : nextName"), 'basename-only rename must keep the file or folder in its current parent');
    assert.ok(sidebar.includes('setSelectedFolderPath(nextSelectedFolderPath)'), 'notes sidebar must update selected folder after folder rename');
    assert.ok(tree.includes('function FolderIcon('), 'notes tree must render a folder icon for folder entries');
    assert.ok(tree.includes('function NewFolderIcon()'), 'notes tree must use an icon button for folder creation');
    assert.ok(tree.includes('function PencilIcon()'), 'notes tree must expose a pencil rename icon');
    assert.ok(tree.includes('aria-expanded={expanded}'), 'folder rows must expose expandable tree state');
    assert.ok(tree.includes('onSelectFolder'), 'folder rows must be selectable as creation targets');
    assert.ok(tree.includes('draggable'), 'note files must be draggable in the tree');
    assert.ok(tree.includes('onDrop'), 'folders must accept dropped note files');
    assert.ok(tree.includes('application/x-cli-jaw-note-path'), 'drag payload must carry a typed note path');
    assert.ok(tree.includes('notes-tree-dirty-dot'), 'dirty notes must render a VS Code-like unsaved marker in the tree');
    assert.ok(tree.includes('notes-tree-inline-action'), 'file and folder rows must expose compact inline actions');
    assert.ok(tree.includes('title="Rename folder"'), 'folder rows must expose a rename pencil action');
    assert.ok(tree.includes('onRenamePath(entry.path, entry.kind)'), 'rename pencil must invoke the path rename handler');
    assert.ok(workspace.includes('onDirtyPathChange'), 'workspace must report dirty note path to the navigator tree');
    assert.equal(tree.includes('title="New folder">/</button>'), false, 'new folder control must not use a slash fallback');
    assert.ok(workspace.includes('event.metaKey || event.ctrlKey'), 'notes workspace must support Cmd/Ctrl+S save');
    assert.ok(workspace.includes("event.key.toLowerCase() !== 's'"), 'notes save shortcut must be limited to the S key');
    assert.ok(workspace.includes('event.preventDefault()'), 'notes save shortcut must suppress browser Save Page');
    assert.ok(workspace.includes('void document.save()'), 'notes save shortcut must call the existing manual save path');
});

test('SidebarRail exposes Instances and Notes workspace modes', () => {
    const rail = read('public/manager/src/components/SidebarRail.tsx');

    assert.ok(rail.includes('DashboardSidebarMode'), 'rail props must use the sidebar mode type');
    assert.ok(rail.includes("onModeChange('instances')"), 'rail must switch to instances mode');
    assert.ok(rail.includes("onModeChange('notes')"), 'rail must switch to notes mode');
    assert.ok(rail.includes('aria-label="Instances"'), 'rail must label Instances mode');
    assert.ok(rail.includes('aria-label="Notes"'), 'rail must label Notes mode');
    assert.ok(rail.includes('rail-button'), 'rail mode controls must keep the existing compact rail button styling');
    assert.ok(rail.includes('rail-workspace-button'), 'rail mode controls must stay compact and must not become navigator text tabs');
    assert.ok(rail.includes('function MonitorIcon()'), 'rail must use an SVG icon for Instances instead of emoji or uppercase fallback');
    assert.ok(rail.includes('function NoteIcon()'), 'rail must use an SVG icon for Notes instead of emoji or uppercase fallback');
    assert.ok(
        rail.indexOf('rail-collapse-button') < rail.indexOf("onModeChange('instances')"),
        'collapse control must stay at the leading edge before mode buttons',
    );
    assert.equal(rail.includes('>I<'), false, 'rail must not use uppercase I as the collapsed Instances icon');
    assert.equal(rail.includes('>N<'), false, 'rail must not use uppercase N as the collapsed Notes icon');
    assert.equal(rail.includes('🖥️'), false, 'rail must not use emoji for Instances');
    assert.equal(rail.includes('📝'), false, 'rail must not use emoji for Notes');
    assert.equal(rail.includes('rail-button-label'), false, 'workspace mode controls must not render large text labels above Navigator');
});

test('App renders NotesWorkspace outside Workbench and imports notes CSS', () => {
    const app = read('public/manager/src/App.tsx');
    const main = read('public/manager/src/main.tsx');
    const workbench = read('public/manager/src/components/Workbench.tsx');

    assert.ok(app.includes('import { NotesWorkspace }'), 'App must import NotesWorkspace');
    assert.ok(app.includes('import { NotesSidebar }'), 'App must import NotesSidebar for the existing navigator column');
    assert.ok(app.includes("view.sidebarMode === 'notes'"), 'App must branch by sidebar mode');
    assert.ok(app.includes('<NotesSidebar'), 'App must render the Notes file tree in the manager sidebar');
    assert.ok(app.includes('<NotesWorkspace'), 'App must render NotesWorkspace');
    assert.ok(main.includes('./manager-notes.css'), 'manager notes CSS must be loaded');
    assert.equal(workbench.includes("'notes'"), false, 'Workbench tabs must not include Notes');
});
