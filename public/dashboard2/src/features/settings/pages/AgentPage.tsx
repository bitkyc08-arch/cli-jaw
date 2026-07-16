import type { JSX } from 'react';
import { ModelSettingsPanel } from '../../../models/ModelSettingsPanel.tsx';
import type { SettingsPageProps } from '../settings-types.ts';

export function AgentPage({ port }: SettingsPageProps): JSX.Element {
    return <ModelSettingsPanel
        port={port}
        mode="default"
        title="Agent defaults"
        description="Choose persistent provider, model, and effort defaults for the selected instance. Active Chat overrides remain separate."
    />;
}
