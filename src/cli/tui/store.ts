import { createComposerState, createPasteCaptureState, type ComposerState, type PasteCaptureState } from './composer.js';
import { createAutocompleteState, type AutocompleteState } from './overlay.js';
import { createPaneState, type PaneState } from './panes.js';
import { createTranscriptState, type TranscriptState } from './transcript.js';

export interface OverlayState {
    helpOpen: boolean;
    paletteOpen: boolean;
    paletteFilter: string;
    paletteSelected: number;
    paletteItems: { name: string; desc: string; args: string }[];
}

export function createOverlayState(): OverlayState {
    return {
        helpOpen: false,
        paletteOpen: false,
        paletteFilter: '',
        paletteSelected: 0,
        paletteItems: [],
    };
}

export interface TuiStore {
    composer: ComposerState;
    pasteCapture: PasteCaptureState;
    autocomplete: AutocompleteState;
    panes: PaneState;
    transcript: TranscriptState;
    overlay: OverlayState;
}

export function createTuiStore(): TuiStore {
    return {
        composer: createComposerState(),
        pasteCapture: createPasteCaptureState(),
        autocomplete: createAutocompleteState(),
        panes: createPaneState(),
        transcript: createTranscriptState(),
        overlay: createOverlayState(),
    };
}
