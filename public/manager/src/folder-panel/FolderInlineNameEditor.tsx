import { useEffect, useRef } from 'react';

type FolderInlineNameEditorProps = {
    initialName: string;
    busy: boolean;
    label: string;
    onCancel: () => void;
    onSubmit: (name: string) => void;
};

export function FolderInlineNameEditor(props: FolderInlineNameEditorProps) {
    const inputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        input.select();
    }, [props.initialName]);

    return (
        <form
            className="folder-inline-editor"
            aria-label={props.label}
            onSubmit={(event) => {
                event.preventDefault();
                const nextName = inputRef.current?.value.trim() ?? '';
                if (nextName) props.onSubmit(nextName);
            }}
        >
            <input
                ref={inputRef}
                className="folder-inline-editor__input"
                defaultValue={props.initialName}
                disabled={props.busy}
                onBlur={() => {
                    if (!props.busy) props.onCancel();
                }}
                onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        props.onCancel();
                    }
                    event.stopPropagation();
                }}
            />
        </form>
    );
}
