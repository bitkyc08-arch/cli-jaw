import type { SettingsPageProps } from '../../types';
import { COPY, normalizeDashboardLocale, TitleSupportSummary } from './shared';
export default function Activity({manager}: SettingsPageProps) {
    if (!manager) return null;
    const locale = normalizeDashboardLocale(manager.ui.locale), copy = COPY[locale];
    return <section className="dashboard-settings-section"><header><h3>{copy.activityTitle}</h3><p>{copy.activityDescription}</p></header>
        <TitleSupportSummary support={manager.titleSupport} locale={locale}/></section>;
}
