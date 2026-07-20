import type { JSX } from 'react';
import type { SlashCommand } from './slash-model.ts';

interface SlashCommandMenuProps {
    commands: readonly SlashCommand[];
    activeIndex: number;
    error?: string | null;
    onSelect(command: SlashCommand): void;
}

export function SlashCommandMenu({ commands, activeIndex, error, onSelect }: SlashCommandMenuProps): JSX.Element {
    return (
        <div className="d2-composer-menu" role="listbox" aria-label="Slash commands" id="d2-slash-menu">
            {error ? <div className="d2-composer-menu-state">Commands unavailable</div> : null}
            {!error && commands.length === 0 ? <div className="d2-composer-menu-state">No matching commands</div> : null}
            {!error ? commands.map((command, index) => (
                <button
                    key={command.name}
                    type="button"
                    role="option"
                    id={`d2-slash-opt-${index}`}
                    aria-selected={index === activeIndex}
                    className={index === activeIndex ? 'is-active' : undefined}
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => onSelect(command)}
                >
                    <strong>/{command.name.replace(/^\//, '')}</strong>
                    <span>{command.desc || command.args || ''}</span>
                </button>
            )) : null}
        </div>
    );
}
