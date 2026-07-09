import { createWidget } from '../sample';

export function renderWidget(name) {
    return createWidget({ label: name });
}
