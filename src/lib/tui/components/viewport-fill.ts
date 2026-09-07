import type { Component } from "../tui";

/**
 * Sentinel line a ViewportFill renders; the TUI expands it to the viewport
 * remainder during frame assembly (see TUI #expandViewportFill). Contains
 * control characters so it can never collide with real content.
 */
export const VIEWPORT_FILL_SENTINEL = "\x00__jwc_viewport_fill__\x00";

/**
 * Stretchable spacer that pins everything mounted after it to the bottom of
 * the terminal. Renders a single sentinel line; the TUI replaces it with
 * `max(0, rows - otherLines)` blank lines, so the components below it sit on
 * the terminal floor while content above grows downward into the gap.
 *
 * When disabled it renders nothing, which
 * restores the legacy "frame ends where content ends" behavior byte-for-byte.
 */
export class ViewportFill implements Component {
	#enabled = true;

	setEnabled(enabled: boolean): void {
		this.#enabled = enabled;
	}

	isEnabled(): boolean {
		return this.#enabled;
	}

	invalidate(): void {
		// Stateless — nothing to invalidate.
	}

	render(_width: number): string[] {
		return this.#enabled ? [VIEWPORT_FILL_SENTINEL] : [];
	}
}
