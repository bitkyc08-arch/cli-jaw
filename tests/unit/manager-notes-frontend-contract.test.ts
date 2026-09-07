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
        'public/manager/src/notes/useNotesModel.ts',
        'public/manager/src/notes/NotesFileTree.tsx',
        'public/manager/src/notes/NotesSearchSidebar.tsx',
        'public/manager/src/notes/NotesQuickSwitcher.tsx',
        'public/manager/src/notes/NotesToolbar.tsx',
        'public/manager/src/notes/NotesEmptyState.tsx',
        'public/manager/src/notes/useNoteDocument.ts',
        'public/manager/src/notes/notes-api.ts',
        'public/manager/src/notes/notes-search.css',
        'public/manager/src/notes/notes-quick-switcher.css',
        'public/manager/src/notes/notes-graph.css',
        'public/manager/src/notes/graph/notes-graph-settings.ts',
        'public/manager/src/notes/graph/notes-graph-filter.ts',
        'public/manager/src/notes/graph/notes-graph-force.ts',
        'public/manager/src/notes/graph/NotesGraphCanvas.tsx',
        'public/manager/src/notes/graph/NotesGraphControlsPanel.tsx',
        'public/manager/src/notes/graph/NotesGraphWorkspace.tsx',
        'public/manager/src/notes/wiki-link-resolver.ts',
        'public/manager/src/notes/wiki-link-suggestions.ts',
        'public/manager/src/notes/wiki-link-codemirror-completion.ts',
        'public/manager/src/notes/wysiwyg/milkdown-wikilink-completion.ts',
        'public/manager/src/notes/editor-theme.ts',
        'public/manager/src/manager-notes.css',
    ].forEach(path => {
        assert.equal(existsSync(join(projectRoot, path)), true, `${path} must exist`);
    });

    const api = read('public/manager/src/notes/notes-api.ts');
    assert.ok(api.includes('fetchNotesTree'), 'notes API wrapper must re-export tree fetch');
    assert.ok(api.includes('fetchNotesIndex'), 'notes API wrapper must re-export index fetch');
    assert.ok(api.includes('fetchNotesCapabilities'), 'notes API wrapper must re-export capabilities fetch');
    assert.ok(api.includes('fetchNoteFile'), 'notes API wrapper must re-export file fetch');
    assert.ok(api.includes('saveNoteFile'), 'notes API wrapper must re-export file save');
    assert.ok(api.includes('trashNotePath'), 'notes API wrapper must expose trash');
});

test('Notes API and create actions surface backend/fallback failures without uncaught JSON parse crashes', () => {
    const api = read('public/manager/src/api.ts');
    const sidebar = read('public/manager/src/notes/NotesSidebar.tsx');
    const model = read('public/manager/src/notes/useNotesModel.ts');
    const tree = read('public/manager/src/notes/NotesFileTree.tsx');
    const workspace = read('public/manager/src/notes/NotesWorkspace.tsx');
    const graphSettings = read('public/manager/src/notes/graph/notes-graph-settings.ts');
    const graphFilter = read('public/manager/src/notes/graph/notes-graph-filter.ts');
    const graphWorkspace = read('public/manager/src/notes/graph/NotesGraphWorkspace.tsx');
    const graphControls = read('public/manager/src/notes/graph/NotesGraphControlsPanel.tsx');
    const graphCss = read('public/manager/src/notes/notes-graph.css');
    const toolbar = read('public/manager/src/notes/NotesToolbar.tsx');
    const searchSidebar = read('public/manager/src/notes/NotesSearchSidebar.tsx');
    const quickSwitcher = read('public/manager/src/notes/NotesQuickSwitcher.tsx');
    const searchCss = read('public/manager/src/notes/notes-search.css');
    const quickSwitcherCss = read('public/manager/src/notes/notes-quick-switcher.css');
    const css = read('public/manager/src/manager-notes.css');
    const app = read('public/manager/src/App.tsx');
    const router = read('public/manager/src/SidebarRailRouter.tsx');
    const main = read('public/manager/src/main.tsx');
    const commandPalette = read('public/manager/src/components/CommandPalette.tsx');
    const useCommandPalette = read('public/manager/src/hooks/useCommandPalette.ts');

    assert.ok(api.includes('response.text()'), 'notes response parsing must inspect text before JSON parsing');
    assert.ok(api.includes('invalid_json'), 'notes response parsing must classify non-JSON responses');
    assert.ok(api.includes('DashboardApiError'), 'notes response parsing must surface typed API errors');
    assert.ok(api.includes('/api/dashboard/notes/index'), 'notes API must expose the vault index endpoint');
    assert.ok(api.includes('/api/dashboard/notes/capabilities'), 'notes API must expose the capabilities endpoint');
    assert.ok(api.includes('/api/dashboard/notes/search'), 'notes API must expose the search endpoint');
    assert.ok(api.includes('parseNotesResponse<DashboardNoteSearchResult[]>'), 'notes search must surface typed backend errors');
    assert.ok(read('public/manager/src/notes/notes-api.ts').includes('searchNotes'), 'notes feature API barrel must re-export search');
    assert.ok(read('public/manager/src/notes/notes-types.ts').includes('NoteSearchResult'), 'notes feature types must expose search result type');
    assert.ok(model.includes('fetchNotesTree()'), 'notes model must own tree fetching above the sidebar');
    assert.ok(model.includes('fetchNotesIndex()'), 'notes model must own index fetching above the sidebar');
    assert.ok(model.includes('Promise.all'), 'notes model must refresh tree and index together');
    assert.ok(model.includes('requestIdRef'), 'notes model must prevent stale refreshes from overwriting newer state');
    assert.ok(model.includes("useInvalidationSubscription('notes'"), 'notes model must refresh from notes invalidations');
    assert.ok(model.includes('const selectedPathRef = useRef(options.selectedPath)'),
        'notes model must keep selectedPath in a ref so refresh identity is not tied to render-local props');
    assert.ok(model.includes('selectedPathRef.current = options.selectedPath'),
        'notes model must update selectedPathRef each render');
    assert.ok(model.includes('const onSelectedPathChangeRef = useRef(options.onSelectedPathChange)'),
        'notes model must keep onSelectedPathChange in a ref so App inline callbacks do not trigger refresh loops');
    assert.ok(model.includes('onSelectedPathChangeRef.current = options.onSelectedPathChange'),
        'notes model must update onSelectedPathChangeRef each render');
    assert.ok(model.includes('onSelectedPathChangeRef.current(nextSelected)'),
        'notes model must clear stale selected paths through the latest selection callback');
    const refreshDeps = model.match(/const refresh = useCallback\([\s\S]*?\}, \[(.*?)\]\);/);
    assert.ok(refreshDeps, 'notes model must expose refresh through useCallback');
    assert.equal(refreshDeps[1].trim(), '',
        'notes refresh callback must be stable; selectedPath and inline App callbacks must not retrigger the initial refresh effect every render');
    assert.equal(sidebar.includes('fetchNotesTree'), false, 'notes sidebar must not independently fetch the tree');
    assert.ok(sidebar.includes('async function createNote()'), 'notes sidebar must own create note action');
    assert.ok(sidebar.includes("export type NotesSidebarMode = 'files' | 'search'"), 'notes sidebar must define local Files/Search modes');
    assert.equal(sidebar.includes('notes-sidebar-mode-tabs'), false, 'notes sidebar must not render Files/Search mode tabs');
    assert.ok(sidebar.includes('function SearchIcon()'), 'notes sidebar must expose search as a compact header icon');
    assert.ok(sidebar.includes("className={props.mode === 'search' ? 'is-active' : ''}"), 'notes sidebar search icon must expose active state');
    assert.ok(sidebar.includes("aria-pressed={props.mode === 'search'}"), 'notes sidebar search icon must expose pressed state');
    assert.ok(sidebar.includes("if (props.mode === 'search') props.onModeChange('files')"), 'notes sidebar search icon must toggle back to Files mode');
    assert.ok(sidebar.includes('else props.onOpenSearch()'), 'notes sidebar search icon must use the App focus-aware opener');
    assert.ok(sidebar.includes("props.mode === 'files'"), 'notes sidebar must conditionally render Files mode');
    assert.ok(sidebar.includes('<NotesSearchSidebar'), 'notes sidebar must render Search mode inside the sidebar');
    assert.ok(sidebar.includes('focusToken={props.searchFocusToken}'), 'notes sidebar must pass search focus tokens to the search sidebar');
    assert.ok(sidebar.includes('onModeChange={props.onModeChange}'), 'notes sidebar must pass mode transitions to the search sidebar');
    assert.ok(sidebar.includes('async function createFolder()'), 'notes sidebar must own create folder action');
    assert.ok(sidebar.includes('catch (err)'), 'notes sidebar create actions must catch async API failures');
    assert.ok(sidebar.includes('setError((err as Error).message)'), 'notes sidebar create failures must render as tree errors');
    assert.ok(sidebar.includes('function handleCreateNoteShortcut(event: KeyboardEvent): void'),
        'notes sidebar must register a typed Alt/Option+N create-note shortcut handler');
    assert.ok(sidebar.includes('!event.altKey'),
        'notes create shortcut must require Alt/Option to avoid browser new-window shortcuts');
    assert.ok(sidebar.includes('event.metaKey || event.ctrlKey || event.shiftKey'),
        'notes create shortcut must avoid reserved Cmd/Ctrl/Shift browser combinations');
    assert.ok(sidebar.includes("event.key.toLowerCase() !== 'n'"),
        'notes create shortcut must be bound to N');
    assert.ok(sidebar.includes('event.preventDefault()'),
        'notes create shortcut must suppress the browser new-window default');
    assert.ok(sidebar.includes('void createNote()'),
        'notes create shortcut must reuse the existing file-path create flow');
    assert.ok(model.includes('function hasFile('), 'notes model must verify registry-selected note paths against the current tree');
    assert.ok(model.includes('onSelectedPathChangeRef.current(nextSelected)'), 'notes model must clear stale selected paths when the tree does not contain them');
    assert.ok(sidebar.includes('selectedFolderPath'), 'notes sidebar must track the selected folder for nested note/folder creation');
    assert.ok(sidebar.includes('createNoteFolder(name)'), 'notes sidebar must call the folder creation API');
    assert.ok(sidebar.includes('renameNotePath'), 'notes sidebar must use notes rename API for drag-to-folder moves');
    assert.ok(sidebar.includes('function movePathToFolder('), 'notes sidebar must derive the moved path from the target folder');
    assert.ok(sidebar.includes('async function movePath('), 'notes sidebar must own file and folder drag move error handling');
    assert.ok(sidebar.includes('function rebasePath('), 'notes sidebar must rebase selected paths after folder renames');
    assert.ok(sidebar.includes('function pathName('), 'notes sidebar must derive compact basename defaults for rename prompts');
    assert.ok(sidebar.includes('function renameTarget('), 'notes sidebar must preserve the current parent folder for basename-only renames');
    assert.ok(sidebar.includes('async function renamePath('), 'notes sidebar must own file and folder rename error handling');
    assert.ok(sidebar.includes('trashNotePath'), 'notes sidebar must call trash API');
    assert.ok(sidebar.includes('async function trashPath('), 'notes sidebar must own trash error handling');
    assert.ok(sidebar.includes('window.confirm'), 'notes trash must confirm destructive action');
    assert.ok(sidebar.includes('props.dirtyPath'), 'notes trash must account for dirty selected notes');
    assert.ok(sidebar.includes('props.onSelectedPathChange(null)'), 'trashing selected path must clear stale selection before repair');
    assert.ok(sidebar.includes('restoreHint'), 'dashboard trash status must surface restore hints');
    assert.ok(sidebar.includes("const folderWasInside = kind === 'folder'"), 'file trash must not clear selectedFolderPath');
    assert.ok(sidebar.includes(': false;'), 'non-folder trash must keep selectedFolderPath unchanged');
    assert.ok(sidebar.includes('Restore from: ${result.restoreHint}'), 'dashboard trash status must include the concrete restore hint path');
    assert.ok(sidebar.includes("kind === 'folder' ? 'Rename folder' : 'Rename note'"), 'notes sidebar must prompt for the correct rename target type');
    assert.ok(sidebar.includes('window.prompt(label, pathName(path))'), 'rename prompts must show only the item name by default');
    assert.ok(sidebar.includes("parent ? `${parent}/${nextName}` : nextName"), 'basename-only rename must keep the file or folder in its current parent');
    assert.ok(sidebar.includes('setSelectedFolderPath(nextSelectedFolderPath)'), 'notes sidebar must update selected folder after folder rename');
    assert.ok(tree.includes('function FolderIcon('), 'notes tree must render a folder icon for folder entries');
    assert.ok(tree.includes('export function NewFolderIcon()'), 'notes tree must export an icon button for folder creation');
    assert.ok(tree.includes('function PencilIcon()'), 'notes tree must expose a pencil rename icon');
    assert.ok(tree.includes('aria-expanded={expanded}'), 'folder rows must expose expandable tree state');
    assert.ok(tree.includes('onSelectFolder'), 'folder rows must be selectable as creation targets');
    assert.ok(tree.includes('onTrashPath'), 'notes tree must expose trash action prop');
    assert.ok(tree.includes("event.key === 'Delete'"), 'tree keyboard delete must route through trash');
    assert.ok(tree.includes("event.key === 'Backspace'"), 'tree keyboard backspace must route through trash');
    assert.ok(tree.includes('function isEditableShortcutTarget('), 'notes tree global destructive shortcuts must not run from editable fields');
    assert.ok(tree.includes('function handleCommandTrash(event: globalThis.KeyboardEvent): void'),
        'notes tree must register a Cmd/Ctrl+Delete trash shortcut for selected tree entries');
    assert.ok(tree.includes('event.defaultPrevented'), 'global trash shortcut must not double-fire after row-level keyboard handling');
    assert.ok(tree.includes("props.selectedFolderPath && pathKindLookup.get(props.selectedFolderPath) === 'folder'"),
        'Cmd/Ctrl+Delete must trash the selected folder even when no file path is selected');
    assert.ok(tree.includes('activeTreePath'),
        'notes tree must track the last active file or folder row for copy-path shortcuts');
    assert.ok(tree.includes('setActiveTreePath(path)'),
        'tree row clicks must update the active copy-path target');
    assert.ok(tree.includes('isEditableShortcutTarget(event.target)'),
        'copy-path shortcut must not steal Cmd/Ctrl+Shift+C from editors or inputs');
    assert.ok(tree.includes('activeTreePath && pathKindLookup.has(activeTreePath)'),
        'copy-path shortcut must prefer the active tree target over stale selected file state');
    assert.ok(tree.includes("event.key === 'F2'"), 'tree keyboard rename must be available');
    assert.ok(tree.includes("event.key === 'Enter'"), 'tree keyboard enter must open files or toggle folders');
    assert.ok(tree.includes('options.onSelectFolder?.(entry.path)'), 'folder Enter must select the folder target');
    assert.ok(tree.includes('options.toggleFolder?.(entry.path)'), 'folder Enter must toggle folder expansion');
    assert.ok(tree.includes('event.stopPropagation()'), 'inline file and folder actions must not select/open rows');
    assert.ok(tree.includes('if (multiSelected.size > 0) setMultiSelected(new Set())'),
        'plain tree item clicks must clear multi-selection');
    assert.match(tree, /onEntryClick\(entry\.path, event\);\s*props\.onSelectPath\(entry\.path\);/,
        'plain file clicks must clear multi-selection before selecting the file');
    assert.match(tree, /onEntryClick\(entry\.path, event\);\s*props\.onSelectFolder\(entry\.path\);/,
        'plain folder clicks must clear multi-selection before selecting the folder');
    assert.equal(tree.includes('function TrashIcon()'), false, 'notes tree must not expose a visible trash icon');
    assert.equal(tree.includes('notes-tree-danger-action'), false, 'notes tree must keep trash as keyboard-only action');
    assert.equal(css.includes('.notes-tree-list button'), false, 'tree-wide button width must not stretch inline action buttons');
    assert.ok(css.includes('text-overflow: ellipsis'), 'long note and folder names must truncate with ellipsis');
    assert.ok(css.includes('white-space: nowrap'), 'note and folder names must stay on one line');
    assert.match(tree, /className="notes-tree-folder-button"[\s\S]*?draggable/, 'note folders must be draggable in the tree');
    assert.match(tree, /draggedPath !== entry\.path[\s\S]*?!entry\.path\.startsWith/, 'folder drops must reject self and descendant cycles');
    assert.ok(tree.includes('draggable'), 'note files must be draggable in the tree');
    assert.ok(tree.includes('onDrop'), 'folders must accept dropped note files and folders');
    assert.ok(tree.includes('application/x-cli-jaw-note-path'), 'drag payload must carry a typed note path');
    assert.ok(tree.includes('notes-tree-dirty-dot'), 'dirty notes must render a VS Code-like unsaved marker in the tree');
    assert.ok(tree.includes('notes-tree-inline-action'), 'file and folder rows must expose compact inline actions');
    assert.ok(tree.includes('title="Rename folder"'), 'folder rows must expose a rename pencil action');
    assert.ok(tree.includes('onRenamePath(entry.path, entry.kind)'), 'rename pencil must invoke the path rename handler');
    assert.ok(workspace.includes('onDirtyPathChange'), 'workspace must report dirty note path to the navigator tree');
    assert.equal(tree.includes('title="New folder">/</button>'), false, 'new folder control must not use a slash fallback');
    assert.ok(workspace.includes('event.metaKey || event.ctrlKey'), 'notes workspace must support Cmd/Ctrl+S save');
    assert.ok(workspace.includes('if (!props.active) return;'), 'hidden persistent Notes workspace must not keep the global save shortcut active');
    assert.ok(workspace.includes("event.key.toLowerCase() !== 's'"), 'notes save shortcut must be limited to the S key');
    assert.ok(workspace.includes('event.preventDefault()'), 'notes save shortcut must suppress browser Save Page');
    assert.ok(workspace.includes('void document.save()'), 'notes save shortcut must call the existing manual save path');
    assert.equal(workspace.includes('NotesSearchPanel'), false, 'notes workspace must not render a floating search panel');
    assert.equal(workspace.includes('setSearchOpen'), false, 'notes workspace must not own local overlay search state');
    assert.ok(workspace.includes('onOpenSidebarSearch: () => void'), 'notes workspace must receive the App-owned sidebar search opener');
    assert.ok(workspace.includes('props.onOpenSidebarSearch()'), 'notes workspace shortcut must open sidebar Search mode');
    assert.ok(workspace.includes("event.key.toLowerCase() !== 'f'"), 'notes search shortcut must be bound to F');
    assert.ok(workspace.includes('!event.shiftKey'), 'notes search shortcut must require Shift');
    assert.ok(workspace.includes("import { NotesQuickSwitcher } from './NotesQuickSwitcher'"), 'notes workspace must import the Notes quick switcher');
    assert.ok(workspace.includes('const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false)'), 'notes workspace must own local quick switcher state');
    assert.ok(workspace.includes('isQuickSwitcherShortcut(event)'), 'notes quick switcher shortcut must be bound through the shift-safe helper');
    assert.ok(workspace.includes('setQuickSwitcherOpen(open => !open)'), 'Cmd/Ctrl+P must toggle the quick switcher');
    assert.ok(workspace.includes('notes={props.vaultIndex?.notes || []}'), 'quick switcher must consume existing vault index notes');
    assert.ok(workspace.includes('<NotesQuickSwitcher'), 'notes workspace must render the quick switcher');
    assert.ok(workspace.includes('props.onSelectedPathChange(path)'), 'quick switcher selection must reuse notes selection callback');
    assert.equal(toolbar.includes('searchOpen: boolean'), false, 'notes toolbar must not accept search state after sidebar icon owns Search');
    assert.equal(toolbar.includes('onSearchToggle: () => void'), false, 'notes toolbar must not accept a search toggle after sidebar icon owns Search');
    assert.equal(toolbar.includes('aria-pressed={props.searchOpen}'), false, 'notes toolbar must not expose a Search pressed state');
    assert.equal(toolbar.includes('onClick={props.onSearchToggle}'), false, 'notes toolbar must not render a Search action');
    assert.doesNotMatch(toolbar, />\s*Search\s*<\/button>/, 'notes toolbar must not render a visible Search button');
    assert.equal(workspace.includes('searchOpen={props.sidebarSearchActive}'), false, 'notes workspace must not pass search state to the toolbar');
    assert.equal(workspace.includes('onSearchToggle={props.onOpenSidebarSearch}'), false, 'notes workspace must not pass a search toggle to the toolbar');
    assert.ok(app.includes("const [notesSidebarMode, setNotesSidebarMode] = useState<NotesSidebarMode>('files')"), 'App must own the Notes Files/Search sidebar mode');
    assert.ok(app.includes('const [notesSearchFocusToken, setNotesSearchFocusToken] = useState(0)'), 'App must own a Notes search focus token');
    assert.ok(app.includes('function openNotesSidebarSearch(): void'), 'App must expose a sidebar search opener');
    assert.ok(app.includes("setNotesSidebarMode('search')"), 'App search opener must switch the sidebar to Search mode');
    assert.ok(app.includes('setNotesSearchFocusToken(token => token + 1)'), 'App search opener must request input focus');
    assert.ok(router.includes('mode={props.notesSidebarMode}'), 'SidebarRailRouter must pass Notes sidebar mode to NotesSidebar');
    assert.ok(router.includes('searchFocusToken={props.notesSearchFocusToken}'), 'SidebarRailRouter must pass search focus token to NotesSidebar');
    assert.ok(router.includes('onModeChange={props.onNotesSidebarModeChange}'), 'SidebarRailRouter must pass NotesSidebar mode changes back to App');
    assert.ok(router.includes('onOpenSearch={props.onOpenNotesSearch}'), 'SidebarRailRouter must pass the focus-aware search opener to NotesSidebar');
    assert.equal(app.includes("sidebarSearchActive={notesSidebarMode === 'search'}"), false, 'App must not pass removed toolbar search active state to NotesWorkspace');
    assert.ok(router.includes('onOpenSidebarSearch={props.onOpenNotesSearch}'), 'SidebarRailRouter must pass search opener to NotesWorkspace');
    assert.ok(main.includes("./notes/notes-graph.css"), 'manager entrypoint must load dedicated graph CSS');
    assert.ok(app.includes('handleNotesGraphSettingsChange'), 'App must persist graph controls through dashboard registry UI');
    assert.ok(router.includes('notesGraphSettings={props.notesGraphSettings}'), 'router must pass graph settings to NotesWorkspace');
    assert.ok(workspace.includes("import('./graph/NotesGraphWorkspace')"), 'NotesWorkspace must lazy-load the graph workspace');
    assert.ok(workspace.includes('onSettingsChange={props.onNotesGraphSettingsChange}'), 'NotesWorkspace must wire graph settings persistence');
    assert.ok(graphSettings.includes('existingFilesOnly: false'), 'graph settings must default to showing unresolved links');
    assert.ok(graphFilter.includes("node.kind === 'missing'"), 'graph filter must keep missing-link node handling explicit');
    assert.ok(graphFilter.includes('settings.focusSelected'), 'graph filter must support selected-note focus mode');
    assert.ok(graphWorkspace.includes('NotesGraphControlsPanel'), 'graph workspace must render the controls panel');
    assert.ok(graphControls.includes('Focus selected'), 'graph controls must expose focus selected');
    assert.ok(graphCss.includes('.notes-graph-controls'), 'graph CSS must style the controls panel');
    assert.ok(searchSidebar.includes('AbortController'), 'notes search sidebar must cancel stale searches');
    assert.ok(searchSidebar.includes('isAbortError'), 'notes search sidebar must distinguish aborts from real failures');
    assert.ok(searchSidebar.includes('notes-search-error'), 'notes search sidebar must render actionable errors');
    assert.ok(searchSidebar.includes('searchNotes(trimmed'), 'notes search sidebar must call the notes search API');
    assert.ok(searchSidebar.includes('focusToken'), 'notes search sidebar must focus the search input from App tokens');
    assert.ok(searchSidebar.includes("props.onModeChange('files')"), 'Escape in notes search sidebar must return to Files mode');
    assert.ok(searchSidebar.includes("result.kind === 'path' ? 'Path match'"), 'notes search sidebar must label file/path matches');
    assert.equal(searchCss.includes('.notes-sidebar-mode-tabs'), false, 'search CSS must not style removed Files/Search tabs');
    assert.ok(searchCss.includes('.notes-tree-actions button.is-active'), 'search CSS must style the active header search icon');
    assert.ok(searchCss.includes('.notes-search-sidebar'), 'search CSS must style the sidebar search surface');
    assert.ok(searchCss.includes('.notes-search-sidebar-results'), 'search CSS must keep sidebar search results scrollable');
    assert.equal(searchCss.includes('.notes-search-panel'), false, 'search CSS must not keep the floating overlay panel');
    assert.equal(searchCss.includes('position: absolute'), false, 'search CSS must not absolutely position search results over the editor');
    assert.equal(searchCss.includes('top: 12px'), false, 'search CSS must not cover the toolbar search button');
    assert.ok(quickSwitcher.includes("import type { NoteMetadata } from '../types'"), 'quick switcher must use shared vault index note metadata');
    assert.ok(quickSwitcher.includes('export function filterQuickSwitcherNotes'), 'quick switcher scoring must be exported for focused unit tests');
    assert.ok(quickSwitcher.includes('role="dialog"'), 'quick switcher must render a dialog');
    assert.ok(quickSwitcher.includes('aria-modal="true"'), 'quick switcher dialog must be modal');
    assert.ok(quickSwitcher.includes('role="listbox"'), 'quick switcher results must expose stable listbox semantics');
    assert.ok(quickSwitcher.includes('role="option"'), 'quick switcher results must expose options');
    assert.ok(quickSwitcher.includes("className={`notes-quick-switcher-item${active ? ' is-active' : ''}${current ? ' is-current' : ''}`"), 'quick switcher must mark active and current rows');
    assert.ok(quickSwitcher.includes("current ? 'Current note'"), 'quick switcher must visibly label the current selected note');
    assert.ok(quickSwitcher.includes('onClick={props.onClose}'), 'quick switcher backdrop click must close the dialog');
    assert.ok(quickSwitcher.includes("event.key === 'ArrowDown'"), 'quick switcher must handle ArrowDown');
    assert.ok(quickSwitcher.includes("event.key === 'ArrowUp'"), 'quick switcher must handle ArrowUp');
    assert.ok(quickSwitcher.includes("event.key === 'Enter'"), 'quick switcher must handle Enter');
    assert.ok(quickSwitcher.includes("event.key === 'Escape'"), 'quick switcher must handle Escape');
    assert.ok(quickSwitcher.includes('note.aliases.map'), 'quick switcher must match aliases as well as title/path');
    assert.ok(quickSwitcherCss.includes('.notes-quick-switcher-backdrop'), 'quick switcher CSS must style the backdrop');
    assert.ok(quickSwitcherCss.includes('.notes-quick-switcher-list'), 'quick switcher CSS must keep results scrollable');
    assert.ok(quickSwitcherCss.includes('.notes-quick-switcher-item.is-current'), 'quick switcher CSS must style the current note marker');
    assert.ok(main.includes("./notes/notes-quick-switcher.css"), 'main entry must import the split notes quick switcher CSS');
    assert.ok(main.includes("./notes/notes-search.css"), 'main entry must import the split notes search CSS');
    assert.ok(commandPalette.includes('CommandPalette'), 'manager command palette must remain present');
    assert.ok(useCommandPalette.includes("event.key !== 'k' && event.key !== 'K'"), 'manager command palette must remain on Cmd/Ctrl+K');
    assert.ok(workspace.includes('className="notes-content"'), 'notes toolbar body must be wrapped so document panes land in a constrained scroll row');
    assert.ok(css.includes('grid-template-rows: max-content minmax(0, 1fr);'), 'notes main grid must reserve a fixed toolbar row and a constrained scroll content row');
    assert.ok(css.includes('.notes-content'), 'notes content wrapper must own the error/conflict/document rows');
    assert.ok(css.includes('.notes-document-grid {\n    grid-row: 3;'), 'notes document grid must be pinned to the 1fr scroll row even when no error/conflict row is rendered');
});

test('Notes markdown editor uses Manager-token CodeMirror theme', () => {
    const editor = read('public/manager/src/notes/MarkdownEditor.tsx');
    const theme = read('public/manager/src/notes/editor-theme.ts');

    assert.ok(editor.includes("import { notesEditorTheme, notesSyntaxHighlighting } from './editor-theme'"), 'MarkdownEditor must import the shared notes editor theme');
    assert.ok(editor.includes('notesEditorTheme') && editor.indexOf('notesEditorTheme') < editor.indexOf('markdown({ codeLanguages: languages })'),
        'CodeMirror extensions must include the token-driven theme before markdown support');
    assert.ok(theme.includes('EditorView.theme'), 'editor theme must use CodeMirror EditorView.theme');
    assert.ok(theme.includes('syntaxHighlighting(notesHighlightStyle)'), 'syntax highlighting must be exported as a CodeMirror extension');
    assert.ok(theme.includes('HighlightStyle.define'), 'editor theme must define syntax token colors');
    assert.ok(theme.includes('var(--text-primary)'), 'editor theme must use Manager text tokens');
    assert.ok(theme.includes('var(--canvas-deep)'), 'editor theme must use Manager canvas tokens');
    assert.ok(theme.includes('var(--border-subtle)'), 'editor theme must use Manager border tokens');
    assert.ok(theme.includes('var(--accent-soft)'), 'editor theme must use Manager accent tokens for matching/active-line states');
    assert.ok(theme.includes('var(--selection-bg)'), 'editor theme must use the dedicated selection token so Cmd/Ctrl+A is visibly highlighted in both themes');
    assert.equal(theme.includes('@uiw/codemirror-theme'), false, 'Notes must not add a separate CodeMirror theme dependency');
    assert.equal(theme.includes('#ffffff'), false, 'editor theme must not hardcode light backgrounds');
    assert.equal(theme.includes('#000000'), false, 'editor theme must not hardcode pure black backgrounds');
});

test('SidebarRail exposes Instances, Notes, and Dashboard settings workspace modes', () => {
    const rail = read('public/manager/src/components/SidebarRail.tsx');

    assert.ok(rail.includes('DashboardSidebarMode'), 'rail props must use the sidebar mode type');
    assert.ok(rail.includes("onModeChange('instances')"), 'rail must switch to instances mode');
    assert.ok(rail.includes("onModeChange('notes')"), 'rail must switch to notes mode');
    assert.ok(rail.includes("onModeChange('settings')"), 'rail must switch to Dashboard settings mode');
    assert.ok(rail.includes('aria-label="Instances"'), 'rail must label Instances mode');
    assert.ok(rail.includes('aria-label="Notes"'), 'rail must label Notes mode');
    assert.ok(rail.includes('aria-label="Dashboard settings"'), 'rail must label Dashboard settings mode');
    assert.ok(rail.includes('rail-button'), 'rail mode controls must keep the existing compact rail button styling');
    assert.ok(rail.includes('rail-workspace-button'), 'rail mode controls must stay compact and must not become navigator text tabs');
    assert.ok(rail.includes('function MonitorIcon()'), 'rail must use an SVG icon for Instances instead of emoji or uppercase fallback');
    assert.ok(rail.includes('function NoteIcon()'), 'rail must use an SVG icon for Notes instead of emoji or uppercase fallback');
    assert.ok(rail.includes('function SettingsIcon()'), 'rail must use an SVG icon for Dashboard settings instead of text fallback');
    assert.ok(rail.includes('M9.671 4.136'), 'Dashboard settings rail icon must use a gear/cog shape');
    assert.equal(rail.includes('M10 2.8v2'), false, 'Dashboard settings rail icon must not use a brightness/sun ray shape');
    assert.ok(
        rail.indexOf('rail-collapse-button') < rail.indexOf("onModeChange('instances')"),
        'collapse control must stay at the leading edge before mode buttons',
    );
    assert.equal(rail.includes('>I<'), false, 'rail must not use uppercase I as the collapsed Instances icon');
    assert.equal(rail.includes('>N<'), false, 'rail must not use uppercase N as the collapsed Notes icon');
    assert.equal(rail.includes('>S<'), false, 'rail must not use uppercase S as the collapsed Dashboard settings icon');
    assert.equal(rail.includes('🖥️'), false, 'rail must not use emoji for Instances');
    assert.equal(rail.includes('📝'), false, 'rail must not use emoji for Notes');
    assert.equal(rail.includes('rail-button-label'), false, 'workspace mode controls must not render large text labels above Navigator');
});

test('App renders NotesWorkspace outside Workbench and imports notes CSS', () => {
    const app = read('public/manager/src/App.tsx');
    const router = read('public/manager/src/SidebarRailRouter.tsx');
    const main = read('public/manager/src/main.tsx');
    const workbench = read('public/manager/src/components/Workbench.tsx');
    const workspace = read('public/manager/src/notes/NotesWorkspace.tsx');
    const notesCss = read('public/manager/src/notes/notes-tags.css');
    const managerNotesCss = read('public/manager/src/manager-notes.css');
    const milkdown = read('public/manager/src/notes/wysiwyg/MilkdownWysiwygEditor.tsx');

    assert.ok(router.includes('import { NotesWorkspace }'), 'SidebarRailRouter must import NotesWorkspace');
    assert.ok(router.includes('import { NotesSidebar, type NotesSidebarMode }'), 'SidebarRailRouter must import NotesSidebar for the existing navigator column and local search mode type');
    assert.ok(app.includes('import { useNotesModel }'), 'App must import the parent-owned Notes model hook');
    assert.ok(router.includes('import { DashboardSettingsWorkspace }'), 'SidebarRailRouter must import Dashboard settings workspace');
    assert.ok(router.includes("from './dashboard-settings/DashboardSettingsSidebar'"), 'SidebarRailRouter must keep the Dashboard settings section type from the settings sidebar module (navigation itself lives in the unified SettingsShell)');
    assert.ok(router.includes("props.sidebarMode === 'notes'"), 'SidebarRailRouter must branch by sidebar mode');
    assert.ok(router.includes("props.sidebarMode === 'settings'"), 'SidebarRailRouter must branch by Dashboard settings mode');
    assert.ok(router.includes('workspace-surface-stack'), 'SidebarRailRouter must keep workspace mode surfaces mounted');
    assert.ok(router.includes("active={props.sidebarMode === 'notes'}"), 'SidebarRailRouter must pass active state to NotesWorkspace and its persistent surface');
    assert.ok(router.includes('<NotesSidebar'), 'SidebarRailRouter must render the Notes file tree in the manager sidebar');
    assert.ok(router.includes('tree={props.notesModel.filteredTree}'), 'SidebarRailRouter must pass the parent-owned filtered Notes tree to the sidebar');
    assert.ok(router.includes('tagFilter={props.notesModel.tagFilter}'), 'SidebarRailRouter must pass the parent-owned tag filter to the sidebar');
    assert.ok(router.includes('onRefreshTree={props.notesModel.refresh}'), 'SidebarRailRouter must pass the parent-owned refresh action to the sidebar');
    assert.ok(router.includes('vaultIndex={props.notesModel.index}'), 'SidebarRailRouter must pass the parent-owned vault index toward the workspace');
    assert.ok(main.includes('./notes/notes-tags.css'), 'notes tag/wikilink CSS must be loaded');
    assert.ok(workspace.includes('selectedOutgoingLinks'), 'WYSIWYG and preview must share selected outgoing links');
    assert.ok(notesCss.includes('.notes-wysiwyg-frontmatter'), 'WYSIWYG frontmatter panel must be styled');
    assert.ok(notesCss.includes('.notes-wysiwyg-frontmatter-empty'), 'WYSIWYG must expose a compact empty frontmatter bar');
    assert.ok(notesCss.includes('.notes-wysiwyg-frontmatter-add'), 'empty frontmatter bar must expose an Add action');
    assert.ok(notesCss.includes('.notes-wikilink-live'), 'WYSIWYG wikilinks must be styled');
    assert.ok(milkdown.includes('composeWysiwygFrontmatter'), 'WYSIWYG changes must recompose frontmatter with editor body');
    assert.ok(
        read('public/manager/src/notes/wysiwyg/WysiwygFrontmatterPanel.tsx').includes('createEmptyWysiwygFrontmatter()'),
        'WYSIWYG must let empty notes create frontmatter from the top properties bar',
    );
    assert.ok(milkdown.includes('notes-milkdown-scroll'), 'WYSIWYG frontmatter must live inside the editor scroll flow');
    assert.ok(
        milkdown.indexOf('<WysiwygFrontmatterPanel') < milkdown.indexOf('className="notes-milkdown-root"'),
        'WYSIWYG frontmatter must render above the Milkdown root, not as an overlay over document content',
    );
    assert.ok(managerNotesCss.includes('flex-direction: column'), 'WYSIWYG shell must use column flow for toolbar, status, frontmatter, and editor');
    assert.ok(managerNotesCss.includes('.notes-milkdown-scroll'), 'WYSIWYG shell must provide one shared scroll container for frontmatter and document body');
    assert.ok(router.includes('<NotesWorkspace'), 'SidebarRailRouter must render NotesWorkspace');
    assert.ok(router.includes("props.sidebarMode === 'settings' ?"), 'SidebarRailRouter must branch the manager sidebar column for Dashboard settings (navigation lives in the unified SettingsShell since 260908 wp4)');
    assert.ok(router.includes('<DashboardSettingsWorkspace'), 'SidebarRailRouter must render Dashboard settings workspace');
    assert.ok(main.includes('./manager-notes.css'), 'manager notes CSS must be loaded');
    assert.ok(main.includes('./manager-dashboard-settings.css'), 'manager dashboard settings CSS must be loaded');
    assert.equal(workbench.includes("'notes'"), false, 'Workbench tabs must not include Notes');
    assert.equal(workbench.includes("'dashboard-settings'"), false, 'Workbench tabs must not include Dashboard settings');
});

test('Notes command palette is scoped to Notes and reuses Quick Switcher shell', () => {
    const router = read('public/manager/src/SidebarRailRouter.tsx');
    const workspace = read('public/manager/src/notes/NotesWorkspace.tsx');
    const sidebar = read('public/manager/src/notes/NotesSidebar.tsx');
    const palette = read('public/manager/src/notes/NotesCommandPalette.tsx');
    const registry = read('public/manager/src/notes/notes-command-registry.tsx');
    const shortcuts = read('public/manager/src/notes/notes-shortcuts.ts');
    const quickSwitcherCss = read('public/manager/src/notes/notes-quick-switcher.css');

    assert.ok(router.includes('NotesCommandProvider'), 'Notes route must provide a Notes command registry');
    assert.ok(router.includes('<NotesCommandPalette'), 'Notes route must render the command palette host');
    assert.ok(workspace.includes('useRegisterNoteCommands(workspaceCommands, props.active)'), 'workspace commands must only register when Notes is active');
    assert.ok(sidebar.includes('useRegisterNoteCommands(sidebarCommands)'), 'sidebar must register create/search/refresh commands');
    assert.ok(workspace.includes('isQuickSwitcherShortcut(event)'), 'quick switcher shortcut must use the shift-safe helper');
    assert.ok(shortcuts.includes('!event.shiftKey'), 'quick switcher shortcut must reject Shift');
    assert.ok(shortcuts.includes('event.shiftKey'), 'command palette shortcut must require Shift');
    assert.ok(registry.includes('useRegisterNoteCommands'), 'command registry must expose the registration hook');
    assert.ok(registry.includes('duplicate command id'), 'command registry must guard duplicate IDs');
    assert.ok(palette.includes('filterNoteCommands'), 'command palette filtering must be exported for focused tests');
    assert.ok(palette.includes('aria-activedescendant'), 'command palette must mirror Quick Switcher active descendant semantics');
    assert.ok(palette.includes('Promise.resolve(command.run())'), 'command palette must catch async command failures');
    assert.ok(quickSwitcherCss.includes('.notes-command-palette-backdrop'), 'Quick Switcher CSS file must own command palette modal styles');
});
