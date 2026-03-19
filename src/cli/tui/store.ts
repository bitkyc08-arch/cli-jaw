import { createComposerState, createPasteCaptureState, type ComposerState, type PasteCaptureState } from './composer.js';
import { createAutocompleteState, type AutocompleteState } from './overlay.js';
import { createPaneState, type PaneState } from './panes.js';

export interface TuiStore {
    composer: ComposerState;
    pasteCapture: PasteCaptureState;
    autocomplete: AutocompleteState;
    panes: PaneState;
}

export function createTuiStore(): TuiStore {
    return {
        composer: createComposerState(),
        pasteCapture: createPasteCaptureState(),
        autocomplete: createAutocompleteState(),
        panes: createPaneState(),
    };
}
