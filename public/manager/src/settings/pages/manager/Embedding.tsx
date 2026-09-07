import type { SettingsPageProps } from '../../types';
import { DashboardEmbeddingSection } from '../../../dashboard-settings/DashboardEmbeddingSection';
import { COPY, normalizeDashboardLocale } from './shared';
export default function Embedding({manager}: SettingsPageProps) {
    if (!manager) return null; const copy = COPY[normalizeDashboardLocale(manager.ui.locale)];
    return <section className="dashboard-settings-section"><header><h3>{copy.embeddingTitle}</h3><p>{copy.embeddingDescription}</p></header>
        <DashboardEmbeddingSection/></section>;
}
