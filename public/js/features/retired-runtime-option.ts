import { isRetiredCliSelection } from '../../../src/types/cli-engine.js';

/** Keep a saved retired value visible without offering it as a new runtime. */
export function preserveRetiredRuntimeOption(select: HTMLSelectElement, current: string): void {
    if (!isRetiredCliSelection(current)) return;
    let option = Array.from(select.options).find(entry => entry.value === current);
    if (!option) {
        option = select.ownerDocument.createElement('option');
        option.value = current;
        select.prepend(option);
    }
    option.disabled = true;
    option.textContent = 'JWC (retired — choose another runtime)';
    select.value = current;
    select.title = 'The saved runtime is retired and cannot execute.';
}
