import '../../../manager/src/manager-tokens.css';
import '../styles/base.css';
import '../styles/tokens-v4.css';
import '../models/model-picker.css';
import '../chat/composer/composer.css';
import { useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Composer, type ComposerEcho } from '../chat/composer/Composer.tsx';
import { ManagerApiProvider } from '../providers/api-provider.tsx';
import type { ModelPickerOption } from '../models/ModelPicker.tsx';

const options: ModelPickerOption[] = [
    { id: 'codex:gpt-5.5', provider: 'codex', model: 'gpt-5.5', label: 'gpt-5.5' },
    { id: 'codex:gpt-5.6-sol', provider: 'codex', model: 'gpt-5.6-sol', label: 'gpt-5.6-sol' },
];

let root: Root | null = null;

function Harness() {
    const [value, setValue] = useState(options[0]!);
    const [echo, setEcho] = useState<ComposerEcho | null>(null);
    return (
        <ManagerApiProvider>
            <main
                style={{ width: 760, padding: '240px 30px 30px' }}
                data-selected={value.id}
                data-echo-status={echo?.status ?? ''}
            >
                <Composer
                    port={3506}
                    picker={{
                        value,
                        options,
                        effort: 'high',
                        workerWide: true,
                        onSelect: setValue,
                    }}
                    onEcho={setEcho}
                />
            </main>
        </ManagerApiProvider>
    );
}

export function mountComposerHarness(target: HTMLElement): void {
    root?.unmount();
    root = createRoot(target);
    root.render(<Harness />);
}

export function unmountComposerHarness(): void {
    root?.unmount();
    root = null;
}
