import type { KeyboardEvent } from 'react';

type CodeComposerProps = {
    inputText: string;
    sending: boolean;
    showCommands: boolean;
    availableCommands: Array<{ name: string; description?: string }>;
    onInputChange: (text: string) => void;
    onCommandSelect: (name: string) => void;
    onSubmit: () => void;
    onShowCommandsChange: (show: boolean) => void;
};

export function CodeComposer(props: CodeComposerProps) {
    const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Escape' && props.showCommands) {
            props.onShowCommandsChange(false);
            return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            props.onSubmit();
        }
    };

    return (
        <div className="code-composer">
            {props.showCommands && props.availableCommands.length > 0 && (
                <div className="code-command-palette">
                    {props.availableCommands
                        .filter(c => !props.inputText || c.name.startsWith(props.inputText))
                        .slice(0, 10)
                        .map(c => (
                            <button key={c.name} type="button" className="code-command-item"
                                onClick={() => props.onCommandSelect(c.name)}>
                                <span className="code-command-name">{c.name}</span>
                                {c.description && <span className="code-command-desc">{c.description}</span>}
                            </button>
                        ))}
                </div>
            )}
            <div className="code-composer-input-shell">
                <textarea
                    className="code-composer-input"
                    value={props.inputText}
                    onChange={e => props.onInputChange(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Describe a task or ask a question..."
                    rows={1}
                    disabled={props.sending}
                />
                <span className="code-composer-hint">Enter to send · / for commands</span>
            </div>
            <button
                type="button"
                className="code-composer-send"
                onClick={props.onSubmit}
                disabled={!props.inputText.trim() || props.sending}
                aria-label="Send prompt"
            >
                Send
            </button>
        </div>
    );
}
