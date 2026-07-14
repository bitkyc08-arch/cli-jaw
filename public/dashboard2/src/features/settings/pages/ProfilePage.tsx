import type { JSX } from 'react';
import { SettingsPageShell } from '../SettingsPageShell.tsx';
import type { SettingsPageProps } from '../settings-types.ts';

export function ProfilePage({ port, dirty }: SettingsPageProps): JSX.Element {
    return <SettingsPageShell title="Profile" description="Set the identity shown across dashboard sessions." source="dashboard" slice="profile" port={port} dirty={dirty} fields={[
        { key: 'displayName', label: 'Display name', kind: 'text', placeholder: 'Your name' },
        { key: 'email', label: 'Email', kind: 'text', placeholder: 'you@example.com' },
        { key: 'avatarUrl', label: 'Avatar URL', kind: 'text', placeholder: 'https://…' },
        { key: 'showReasoning', label: 'Show reasoning traces', kind: 'toggle' },
    ]} />;
}
