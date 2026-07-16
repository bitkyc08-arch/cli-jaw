import '../../../manager/src/manager-tokens.css';
import '../styles/base.css';
import '../styles/tokens-v4.css';
import '../models/model-picker.css';
import { useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ModelPicker, type ModelPickerOption } from '../models/ModelPicker.tsx';

const options: ModelPickerOption[] = [
    { id: 'codex:gpt-5.5', provider: 'codex', model: 'gpt-5.5', label: 'gpt-5.5' },
    { id: 'codex:gpt-5.6-sol', provider: 'codex', model: 'gpt-5.6-sol', label: 'gpt-5.6-sol' },
    { id: 'claude:claude-sonnet-4.6', provider: 'claude', model: 'claude-sonnet-4.6', label: 'claude-sonnet-4.6' },
    { id: 'codex:gpt-5.6-luna', provider: 'codex', model: 'gpt-5.6-luna', label: 'gpt-5.6-luna' },
];

let root: Root | null = null;

function Harness() {
    const [value, setValue] = useState(options[0]!);
    return (
        <main style={{ width: 520, padding: '400px 80px 40px' }} data-selected={value.id}>
            <ModelPicker value={value} options={options} effort="high" workerWide onSelect={setValue} />
            <button type="button" data-testid="after-picker" style={{ marginTop: 24 }}>After picker</button>
        </main>
    );
}

export function mountModelPickerHarness(target: HTMLElement): void {
    root?.unmount();
    root = createRoot(target);
    root.render(<Harness />);
}

export function unmountModelPickerHarness(): void {
    root?.unmount();
    root = null;
}
