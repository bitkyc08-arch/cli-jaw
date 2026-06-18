import type { FolderPanelEntry } from './folder-sources';

type FolderContextMenuProps = {
    entry: FolderPanelEntry;
    x: number;
    y: number;
    canReveal: boolean;
    canRefresh: boolean;
    canMutate: boolean;
    onCopyPath: () => void;
    onCopyRelativePath: () => void;
    onReveal: () => void;
    onRefresh: () => void;
    onCreateFile: () => void;
    onCreateFolder: () => void;
    onRename: () => void;
};

export function FolderContextMenu(props: FolderContextMenuProps) {
    return (
        <div
            className="folder-context-menu"
            role="menu"
            style={{ left: props.x, top: props.y }}
            onPointerDown={event => event.stopPropagation()}
            onKeyDown={event => event.stopPropagation()}
        >
            <button type="button" role="menuitem" onClick={props.onCopyPath}>Copy Path</button>
            <button type="button" role="menuitem" onClick={props.onCopyRelativePath}>Copy Relative Path</button>
            <button type="button" role="menuitem" disabled={!props.canReveal} onClick={props.onReveal}>
                {props.entry.kind === 'directory' ? 'Open Folder' : 'Reveal in Finder'}
            </button>
            <button type="button" role="menuitem" disabled={!props.canMutate} onClick={props.onCreateFile}>New File</button>
            <button type="button" role="menuitem" disabled={!props.canMutate} onClick={props.onCreateFolder}>New Folder</button>
            <button type="button" role="menuitem" disabled={!props.canMutate} onClick={props.onRename}>Rename</button>
            {props.canRefresh && <button type="button" role="menuitem" onClick={props.onRefresh}>Refresh</button>}
        </div>
    );
}
