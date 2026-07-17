import { useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CodeModelControl } from '../code/CodeModelControl.tsx';
import { CodeApiError, type CodeApiClient } from '../code/code-api-client.ts';
import '../models/model-picker.css';
import '../code/code-tab.css';

const models = {
    providers: [{
        id: 'anthropic',
        models: ['claude-sonnet-4.6', 'claude-haiku-4.5', 'claude-opus-4.6'],
        efforts: [],
        modelSource: 'jwc-cache' as const,
    }],
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4.6',
};

const client = {
    listModelOptions: async () => models,
    setSessionModel: async (_sessionId: string, modelId: string) => {
        if (modelId.endsWith('/claude-opus-4.6')) {
            throw new CodeApiError('http_error', 'Code model switch request failed (500)', 500);
        }
        return {
            sessionId: 'browser-session', cwd: '/fixture', status: 'idle' as const,
            createdAt: 1, lastUsedAt: 1, modelId,
        };
    },
} as unknown as CodeApiClient;

function Harness(): JSX.Element {
    const [selected, setSelected] = useState<string | null>('anthropic/claude-sonnet-4.6');
    return (
        <main
            data-testid="code-model-session-harness"
            data-selected={selected ?? ''}
            style={{ minHeight: 380, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}
        >
            <CodeModelControl
                client={client}
                sessionId="browser-session"
                confirmedModelId={selected}
                onSelectionChange={setSelected}
            />
            <button type="button" data-testid="after-code-model">After model picker</button>
        </main>
    );
}

let root: Root | null = null;

export function mountCodeModelSessionHarness(target: HTMLElement): void {
    root?.unmount();
    root = createRoot(target);
    root.render(<Harness />);
}

export function unmountCodeModelSessionHarness(): void {
    root?.unmount();
    root = null;
}
