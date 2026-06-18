type FolderActionRowProps = {
    hasSelection: boolean;
    canReveal: boolean;
    onCopyPath: () => void;
    onCopyRelativePath: () => void;
    onReveal: () => void;
    canMutate: boolean;
    onCreateFile: () => void;
    onCreateFolder: () => void;
    onRename: () => void;
};

export function FolderActionRow(props: FolderActionRowProps) {
    return (
        <div className="folder-action-row" aria-label="Folder actions">
            <button type="button" className="folder-action-btn" disabled={!props.hasSelection} onClick={props.onCopyPath}>Copy</button>
            <button type="button" className="folder-action-btn" disabled={!props.hasSelection} onClick={props.onCopyRelativePath}>Relative</button>
            <button type="button" className="folder-action-btn" disabled={!props.hasSelection || !props.canReveal} onClick={props.onReveal}>Finder</button>
            <button type="button" className="folder-action-btn" disabled={!props.canMutate} onClick={props.onCreateFile}>New File</button>
            <button type="button" className="folder-action-btn" disabled={!props.canMutate} onClick={props.onCreateFolder}>New Folder</button>
            <button type="button" className="folder-action-btn" disabled={!props.hasSelection || !props.canMutate} onClick={props.onRename}>Rename</button>
        </div>
    );
}
