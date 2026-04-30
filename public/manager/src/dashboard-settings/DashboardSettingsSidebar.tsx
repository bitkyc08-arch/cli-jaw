import type { DashboardLocale } from '../types';

type DashboardSettingsSection = 'display' | 'activity';

type DashboardSettingsSidebarProps = {
    activeSection: DashboardSettingsSection;
    locale: DashboardLocale;
    onSectionChange: (section: DashboardSettingsSection) => void;
};

const COPY = {
    ko: {
        navLabel: '대시보드 설정 섹션',
        eyebrow: '대시보드',
        title: '설정',
        sections: {
            display: { label: '사이드바 행', hint: '밀도와 행 안 컨트롤' },
            activity: { label: '미리보기와 활동', hint: '제목 출처와 기본값' },
        },
    },
    en: {
        navLabel: 'Dashboard settings sections',
        eyebrow: 'Dashboard',
        title: 'Settings',
        sections: {
            display: { label: 'Sidebar rows', hint: 'Density and inline controls' },
            activity: { label: 'Preview & activity', hint: 'Title source and defaults' },
        },
    },
    zh: {
        navLabel: '仪表盘设置分区',
        eyebrow: '仪表盘',
        title: '设置',
        sections: {
            display: { label: '侧边栏列表', hint: '密度与行内控件' },
            activity: { label: '预览与活动', hint: '标题来源与默认值' },
        },
    },
    ja: {
        navLabel: 'ダッシュボード設定セクション',
        eyebrow: 'ダッシュボード',
        title: '設定',
        sections: {
            display: { label: 'サイドバーの行', hint: '密度と行内コントロール' },
            activity: { label: 'プレビューとアクティビティ', hint: 'タイトルの取得元と既定値' },
        },
    },
} as const;

const SECTION_IDS: DashboardSettingsSection[] = ['display', 'activity'];

export function DashboardSettingsSidebar(props: DashboardSettingsSidebarProps) {
    const copy = COPY[props.locale] || COPY.ko;
    return (
        <nav className="dashboard-settings-sidebar" aria-label={copy.navLabel}>
            <div className="dashboard-settings-sidebar-header">
                <span className="eyebrow">{copy.eyebrow}</span>
                <strong>{copy.title}</strong>
            </div>
            <div className="dashboard-settings-sidebar-list">
                {SECTION_IDS.map(section => (
                    <button
                        key={section}
                        className={`dashboard-settings-sidebar-button${props.activeSection === section ? ' is-active' : ''}`}
                        type="button"
                        aria-pressed={props.activeSection === section}
                        onClick={() => props.onSectionChange(section)}
                    >
                        <span>{copy.sections[section].label}</span>
                        <small>{copy.sections[section].hint}</small>
                    </button>
                ))}
            </div>
        </nav>
    );
}

export type { DashboardSettingsSection };
