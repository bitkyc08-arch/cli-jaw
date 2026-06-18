type FolderMutationDialogProps = {
    title: string;
    initialName: string;
    confirmLabel: string;
    busy: boolean;
    onCancel: () => void;
    onSubmit: (name: string) => void;
};

export function FolderMutationDialog(props: FolderMutationDialogProps) {
    return (
        <div className="folder-mutation-dialog" role="dialog" aria-modal="true" aria-label={props.title}>
            <form
                className="folder-mutation-dialog__panel"
                onSubmit={(event) => {
                    event.preventDefault();
                    const form = event.currentTarget;
                    const data = new FormData(form);
                    const name = String(data.get('name') ?? '').trim();
                    if (name) props.onSubmit(name);
                }}
            >
                <div className="folder-mutation-dialog__title">{props.title}</div>
                <input
                    name="name"
                    className="folder-mutation-dialog__input"
                    type="text"
                    defaultValue={props.initialName}
                    autoFocus
                    disabled={props.busy}
                    onFocus={event => event.currentTarget.select()}
                    onKeyDown={event => {
                        if (event.key === 'Escape') {
                            event.preventDefault();
                            props.onCancel();
                        }
                    }}
                />
                <div className="folder-mutation-dialog__actions">
                    <button type="button" onClick={props.onCancel} disabled={props.busy}>Cancel</button>
                    <button type="submit" disabled={props.busy}>{props.busy ? 'Working...' : props.confirmLabel}</button>
                </div>
            </form>
        </div>
    );
}
