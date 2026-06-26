import type { DashboardLocale } from '../types';

type DashboardSettingsSection = 'display' | 'activity' | 'developer' | 'embedding' | 'telegramHub';

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
            developer: { label: '개발 도구', hint: 'Git diff 기본값' },
            embedding: { label: '임베딩 검색', hint: 'Provider와 벡터 인덱스' },
            telegramHub: { label: 'Telegram Hub', hint: '포럼 토픽 라우팅' },
        },
    },
    en: {
        navLabel: 'Dashboard settings sections',
        eyebrow: 'Dashboard',
        title: 'Settings',
        sections: {
            display: { label: 'Sidebar rows', hint: 'Density and inline controls' },
            activity: { label: 'Preview & activity', hint: 'Title source and defaults' },
            developer: { label: 'Developer tools', hint: 'Git diff defaults' },
            embedding: { label: 'Embedding search', hint: 'Provider and vector index' },
            telegramHub: { label: 'Telegram Hub', hint: 'Forum topic routing' },
        },
    },
    zh: {
        navLabel: '仪表盘设置分区',
        eyebrow: '仪表盘',
        title: '设置',
        sections: {
            display: { label: '侧边栏列表', hint: '密度与行内控件' },
            activity: { label: '预览与活动', hint: '标题来源与默认值' },
            developer: { label: '开发工具', hint: 'Git diff 默认值' },
            embedding: { label: '嵌入搜索', hint: 'Provider 与向量索引' },
            telegramHub: { label: 'Telegram Hub', hint: '论坛主题路由' },
        },
    },
    ja: {
        navLabel: 'ダッシュボード設定セクション',
        eyebrow: 'ダッシュボード',
        title: '設定',
        sections: {
            display: { label: 'サイドバーの行', hint: '密度と行内コントロール' },
            activity: { label: 'プレビューとアクティビティ', hint: 'タイトルの取得元と既定値' },
            developer: { label: '開発ツール', hint: 'Git diff の既定値' },
            embedding: { label: 'エンベディング検索', hint: 'Provider とベクトルインデックス' },
            telegramHub: { label: 'Telegram Hub', hint: 'フォーラムトピックルーティング' },
        },
    },
} as const;

const SECTION_IDS: DashboardSettingsSection[] = ['display', 'activity', 'developer', 'embedding', 'telegramHub'];

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
