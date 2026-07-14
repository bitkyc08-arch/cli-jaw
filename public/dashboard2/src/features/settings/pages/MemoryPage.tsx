import type { JSX } from 'react';
import { SettingsPageShell } from '../SettingsPageShell.tsx';
import type { SettingsPageProps } from '../settings-types.ts';

export function MemoryPage({ port, dirty }: SettingsPageProps): JSX.Element {
    return <SettingsPageShell title="Memory" description="Manage automatic recall and retention for the selected instance." source="instance" slice="memory" port={port} dirty={dirty} fields={[
        { key: 'enabled', label: 'Enable memory', description: 'Allow agents to store and recall durable context.', kind: 'toggle' },
        { key: 'flushEvery', label: 'Flush every', description: 'Sessions between memory flushes.', kind: 'number', min: 1, max: 100, step: 1 },
        { key: 'retentionDays', label: 'Retention days', kind: 'number', min: 1, max: 3650, step: 1 },
        { key: 'autoReflect', label: 'Reflect after flush', kind: 'toggle' },
    ]} />;
}
