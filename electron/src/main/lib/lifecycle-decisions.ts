/**
 * The window-lifecycle branch decisions, extracted from index.ts so they can
 * be tested without importing the main process.
 *
 * index.ts registers these on `app.on(...)` and `mainWindow.on('close')` at
 * module top level, which makes the branches impossible to import-test: they
 * read module globals (shutdownComplete, forceQuitRequested, mainWindow) and
 * fire side effects (app.quit, requestApplicationQuit). Each decision here is
 * a pure function of the state that branch actually reads, so a test can drive
 * every combination without an Electron runtime.
 */

export interface WindowAllClosedInput {
    keepRunning: boolean;
    platform: NodeJS.Platform | string;
}

/**
 * `window-all-closed`: keep the process alive in the background, or quit on
 * every platform except macOS (where an app with no windows conventionally
 * stays running until Cmd-Q).
 */
export function decideWindowAllClosed(input: WindowAllClosedInput): 'stay' | 'quit' | 'none' {
    if (input.keepRunning) return 'stay';
    return input.platform === 'darwin' ? 'none' : 'quit';
}

export interface BeforeQuitInput {
    shutdownComplete: boolean;
    keepRunning: boolean;
    forceQuitRequested: boolean;
    windowPresent: boolean;
}

/**
 * `before-quit`: with keep-running set and no explicit force-quit, swallow the
 * quit and just close the window; otherwise proceed to the real quit path.
 * `shutdownComplete` short-circuits everything.
 */
export function decideBeforeQuit(input: BeforeQuitInput): 'short-circuit' | 'close-window' | 'request-quit' {
    if (input.shutdownComplete) return 'short-circuit';
    if (input.keepRunning && !input.forceQuitRequested) return 'close-window';
    return 'request-quit';
}

export interface ActivateInput {
    windowPresent: boolean;
}

/** `activate` (dock icon): recreate the manager window only if none exists. */
export function decideActivate(input: ActivateInput): 'recreate' | 'none' {
    return input.windowPresent ? 'none' : 'recreate';
}

export interface WindowCloseInput {
    shutdownComplete: boolean;
    shuttingDown: boolean;
    keepRunning: boolean;
}

/**
 * `mainWindow.on('close')`: while shutting down, let the close happen. With
 * keep-running set, tidy up and drop to the background. Otherwise prevent the
 * close and run the real quit path so the progress UI can show.
 */
export function decideWindowClose(input: WindowCloseInput): 'allow' | 'background' | 'request-quit' {
    if (input.shutdownComplete || input.shuttingDown) return 'allow';
    if (input.keepRunning) return 'background';
    return 'request-quit';
}
