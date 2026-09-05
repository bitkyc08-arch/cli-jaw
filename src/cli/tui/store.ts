import { createComposerState, createPasteCaptureState, type ComposerState, type PasteCaptureState } from './composer.js';
import { createAutocompleteState, type AutocompleteState, type ChoiceSelectorItem } from './overlay.js';
import { createPaneState, type PaneState } from './panes.js';
import { createTranscriptState, type TranscriptState } from './transcript.js';
import { createActivityHistoryPanel, createActivityPasteDrain, type ActivityHistoryPanel, type ActivityPasteDrain } from './activity-history.js';

export interface SelectorState {
    open: boolean;
    commandName: string;
    title: string;
    subtitle: string;
    filter: string;
    selected: number;
    allItems: ChoiceSelectorItem[];
    filteredItems: ChoiceSelectorItem[];
}

export function createSelectorState(): SelectorState {
    return {
        open: false,
        commandName: '',
        title: '',
        subtitle: '',
        filter: '',
        selected: 0,
        allItems: [],
        filteredItems: [],
    };
}

export interface OverlayState {
    activityHistory: ActivityHistoryPanel;
    helpOpen: boolean;
    bgtaskOpen: boolean;
    paletteOpen: boolean;
    settingsOpen: boolean;
    settingsTab: 'appearance';
    settingsSelected: number;
    settingsMessage: string;
    paletteFilter: string;
    paletteSelected: number;
    paletteItems: { name: string; desc: string; args: string }[];
    selector: SelectorState;
}

export function createOverlayState(): OverlayState {
    return {
        activityHistory: createActivityHistoryPanel(),
        helpOpen: false,
        bgtaskOpen: false,
        paletteOpen: false,
        settingsOpen: false,
        settingsTab: 'appearance',
        settingsSelected: 0,
        settingsMessage: '',
        paletteFilter: '',
        paletteSelected: 0,
        paletteItems: [],
        selector: createSelectorState(),
    };
}

export interface TuiStore {
    activityPasteDrain: ActivityPasteDrain;
    composer: ComposerState;
    pasteCapture: PasteCaptureState;
    autocomplete: AutocompleteState;
    panes: PaneState;
    transcript: TranscriptState;
    overlay: OverlayState;
}

export function createTuiStore(): TuiStore {
    return {
        activityPasteDrain: createActivityPasteDrain(),
        composer: createComposerState(),
        pasteCapture: createPasteCaptureState(),
        autocomplete: createAutocompleteState(),
        panes: createPaneState(),
        transcript: createTranscriptState(),
        overlay: createOverlayState(),
    };
}
