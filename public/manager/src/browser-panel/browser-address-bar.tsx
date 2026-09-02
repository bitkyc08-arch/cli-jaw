import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';
import {
    displayedAddress,
    type AddressBarAction,
    type AddressBarState,
} from './browser-address-state';

type BrowserAddressBarProps = {
    inputRef: RefObject<HTMLInputElement | null>;
    state: AddressBarState;
    onDispatch: (action: AddressBarAction) => void;
    onSubmit: () => void;
};

export function BrowserAddressBar(props: BrowserAddressBarProps) {
    const { inputRef, state, onDispatch, onSubmit } = props;

    function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
        if (event.key === 'Enter') {
            event.preventDefault();
            onDispatch({ type: 'submit' });
            onSubmit();
            inputRef.current?.blur();
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            onDispatch({ type: 'escape' });
            inputRef.current?.blur();
        }
    }

    return (
        <input
            ref={inputRef}
            className="browser-url-input"
            type="text"
            value={displayedAddress(state)}
            placeholder="Search or enter URL"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            aria-label="Search or enter URL"
            onFocus={() => {
                onDispatch({ type: 'focus' });
                queueMicrotask(() => inputRef.current?.select());
            }}
            onBlur={() => onDispatch({ type: 'blur' })}
            onChange={event => onDispatch({ type: 'change', draft: event.target.value })}
            onKeyDown={handleKeyDown}
        />
    );
}
