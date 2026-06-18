import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { filterCodeCommands, type CodeCommand } from './code-types';

type CodeComposerProps = {
    inputText: string;
    sending: boolean;
    showCommands: boolean;
    availableCommands: CodeCommand[];
    onInputChange: (text: string) => void;
    onCommandSelect: (command: CodeCommand) => void;
    onSubmit: () => void;
    onShowCommandsChange: (show: boolean) => void;
};

function nextCommandIndex(current: number, delta: number, count: number): number {
    if (count <= 0) return 0;
    return (current + delta + count) % count;
}

function commandActionLabel(command: CodeCommand): string {
    if (command.disabledReason) return 'Disabled';
    if (command.actionType === 'popup') return command.popupKind ? `${command.popupKind} popup` : 'Popup';
    if (command.actionType === 'pass-through') return 'Pass-through';
    if (command.actionType === 'unsupported') return 'Unsupported';
    return 'Insert';
}

export function CodeComposer(props: CodeComposerProps) {
    const [activeIndex, setActiveIndex] = useState(0);
    const filteredCommands = useMemo(
        () => filterCodeCommands(props.availableCommands, props.inputText).slice(0, 10),
        [props.availableCommands, props.inputText],
    );
    const activeCommand = filteredCommands[activeIndex];
    const activeId = activeCommand ? `code-command-option-${activeCommand.name.replace(/[^a-z0-9_-]/gi, '-')}` : undefined;

    useEffect(() => {
        setActiveIndex(0);
    }, [props.inputText, props.availableCommands]);

    useEffect(() => {
        if (activeIndex >= filteredCommands.length) {
            setActiveIndex(Math.max(0, filteredCommands.length - 1));
        }
    }, [activeIndex, filteredCommands.length]);

    const selectCommand = (command: CodeCommand | undefined) => {
        if (!command || command.disabledReason) return;
        props.onCommandSelect(command);
    };

    const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Escape' && props.showCommands) {
            e.preventDefault();
            props.onShowCommandsChange(false);
            return;
        }
        if (props.showCommands && filteredCommands.length > 0) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveIndex(index => nextCommandIndex(index, 1, filteredCommands.length));
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveIndex(index => nextCommandIndex(index, -1, filteredCommands.length));
                return;
            }
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                selectCommand(activeCommand);
                return;
            }
        }
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            props.onSubmit();
        }
    };

    return (
        <div className="code-composer">
            {props.showCommands && filteredCommands.length > 0 && (
                <div
                    className="code-command-palette"
                    role="listbox"
                    aria-label="Code commands"
                    id="code-command-palette"
                >
                    {filteredCommands.map((command, index) => {
                        const active = index === activeIndex;
                        const id = `code-command-option-${command.name.replace(/[^a-z0-9_-]/gi, '-')}`;
                        return (
                            <button
                                id={id}
                                key={command.name}
                                type="button"
                                role="option"
                                aria-selected={active}
                                aria-disabled={command.disabledReason ? true : undefined}
                                className={`code-command-item${active ? ' is-active' : ''}${command.disabledReason ? ' is-disabled' : ''}`}
                                onMouseEnter={() => setActiveIndex(index)}
                                onClick={() => selectCommand(command)}
                            >
                                <span className="code-command-row-main">
                                    <span className="code-command-name">{command.displayName}</span>
                                    {command.description && <span className="code-command-desc">{command.description}</span>}
                                </span>
                                <span className="code-command-row-meta">
                                    <span className="code-command-chip">{command.category}</span>
                                    <span className="code-command-chip">{command.source}</span>
                                    <span className="code-command-chip">{commandActionLabel(command)}</span>
                                </span>
                            </button>
                        );
                    })}
                </div>
            )}
            <div className="code-composer-input-shell">
                <textarea
                    className="code-composer-input"
                    value={props.inputText}
                    onChange={e => props.onInputChange(e.target.value)}
                    onKeyDown={handleKeyDown}
                    aria-controls={props.showCommands ? 'code-command-palette' : undefined}
                    aria-activedescendant={props.showCommands ? activeId : undefined}
                    aria-expanded={props.showCommands}
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
