import type { JSX } from 'react';
import { SettingsPageShell } from '../SettingsPageShell.tsx';
import type { SettingsPageProps } from '../settings-types.ts';

export function AgentPage({ port, dirty }: SettingsPageProps): JSX.Element {
    return <SettingsPageShell title="Agent" description="Set defaults for new agent runs on the selected instance." source="instance" adapterId="agent" port={port} dirty={dirty} fields={[
        { key: 'model', label: 'Default model', description: 'Model used when a session has no override.', kind: 'text', placeholder: 'Provider model ID' },
        { key: 'temperature', label: 'Temperature', description: 'Controls response variability.', kind: 'number', min: 0, max: 2, step: 0.1, unsupported: 'No canonical runtime setting exists.' },
        { key: 'systemPrompt', label: 'System prompt', description: 'Instructions prepended to new sessions.', kind: 'textarea', placeholder: 'Optional system instructions', unsupported: 'No canonical runtime setting exists.' },
    ]} />;
}
