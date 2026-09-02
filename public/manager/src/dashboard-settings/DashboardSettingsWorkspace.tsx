import { Suspense, lazy, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { formatShortcut, MANAGER_SHORTCUT_ACTIONS } from '../manager-shortcuts';
import { DashboardDeveloperSettingsSection } from './DashboardDeveloperSettingsSection';

const LazyEmbedding = lazy(() => import('./DashboardEmbeddingSection').then(m => ({ default: m.DashboardEmbeddingSection })));
const LazyTelegramHub = lazy(() => import('../settings/pages/TelegramHub'));
import { HelpTopicButton } from '../help/HelpTopicButton';
import type { HelpTopicId } from '../help/helpContent';
import type { DashboardLocale, DashboardRegistryUi, DashboardShortcutAction } from '../types';
import type { DashboardActivityTitleSupport } from './activity-title-support';
import { SaveBar } from '../settings/components/SaveBar';
import { createDirtyStore } from '../settings/dirty-store';
import { createSettingsClient } from '../settings/settings-client';
import type { DirtyStore, SaveHandler } from '../settings/types';

type DashboardSettingsWorkspaceProps = {
    activeSection: 'display' | 'activity' | 'developer' | 'embedding' | 'telegramHub';
    ui: DashboardRegistryUi;
    titleSupport: DashboardActivityTitleSupport;
    onUiPatch: (patch: Partial<DashboardRegistryUi>) => void;
    onOpenHelpTopic: (topic: HelpTopicId) => void;
};

const LOCALE_OPTIONS = [
    { value: 'ko', label: '한국어 (ko)' },
    { value: 'en', label: 'English (en)' },
    { value: 'zh', label: '中文 (zh)' },
    { value: 'ja', label: '日本語 (ja)' },
] as const;

function normalizeDashboardLocale(input: unknown): DashboardLocale {
    const match = LOCALE_OPTIONS.find(option => option.value === input);
    return match?.value ?? 'ko';
}

const COPY = {
    ko: {
        ariaLabel: '대시보드 설정',
        eyebrow: '매니저 환경설정',
        title: '대시보드 설정',
        displayTitle: '인스턴스 목록 표시',
        displayDescription: '이 설정은 왼쪽 인스턴스 목록과 저장된 매니저 UI 환경설정에만 적용됩니다.',
        activityTitle: '미리보기와 활동',
        activityDescription: '최근 작업 제목은 각 인스턴스 서버의 endpoint 버전에 따라 달라집니다.',
        embeddingTitle: '임베딩 검색',
        embeddingDescription: '벡터 임베딩 provider를 설정하고 메모리 인덱스를 관리합니다.',
        fields: {
            activity: {
                label: '최근 작업 미리보기',
                scope: '왼쪽 인스턴스 목록',
                description: '요약 endpoint를 지원하는 인스턴스에서 최신 user 또는 assistant 메시지를 정리한 한 줄을 표시합니다.',
            },
            rename: {
                label: '이름 변경 컨트롤',
                scope: '왼쪽 인스턴스 목록',
                description: '대시보드 전용 인스턴스 이름을 편집하는 연필 버튼을 표시합니다.',
            },
            runtime: {
                label: '런타임 줄',
                scope: '왼쪽 인스턴스 목록',
                description: '각 인스턴스 이름 아래에 codex / gpt-5.5 같은 CLI와 모델 정보를 표시합니다.',
            },
            actions: {
                label: '확장 행 액션',
                scope: '선택된 인스턴스 행',
                description: '선택된 인스턴스 행에 Preview, Open, Start, Stop, Restart 버튼을 표시합니다.',
            },
            language: {
                label: '언어',
                scope: '전체 Jaw UI',
                description: 'i18n을 지원하는 매니저 대시보드 화면에 사용할 언어를 저장합니다.',
            },
            shortcuts: {
                label: '전역 단축키',
                scope: 'Manager dashboard',
                description: '입력창과 에디터 바깥에서만 작동하는 Manager 이동 단축키를 켭니다.',
            },
            shortcutFocusInstances: {
                label: '인스턴스 목록',
                scope: '단축키',
                description: 'Instances workspace로 이동합니다.',
            },
            shortcutFocusActiveSession: {
                label: '활성 세션',
                scope: '단축키',
                description: '선택된 인스턴스의 Preview 탭으로 이동합니다.',
            },
            shortcutFocusNotes: {
                label: '노트',
                scope: '단축키',
                description: 'Notes workspace로 이동합니다.',
            },
            shortcutPreviousInstance: {
                label: '이전 인스턴스',
                scope: '단축키',
                description: '현재 필터 목록에서 이전 인스턴스를 선택합니다.',
            },
            shortcutNextInstance: {
                label: '다음 인스턴스',
                scope: '단축키',
                description: '현재 필터 목록에서 다음 인스턴스를 선택합니다.',
            },
            shortcutResetSidebarWidth: {
                label: '사이드바 폭 리셋',
                scope: '단축키',
                description: '기본 300으로 되돌리고 \'jaw.sidebarWidth\' 키를 지운다.',
            },
        },
        support: {
            ariaLabel: '작업 제목 출처 준비 상태',
            ready: '준비됨',
            legacy: '레거시 endpoint',
            offline: '오프라인',
            empty: '현재 표시할 인스턴스가 없습니다.',
            restart: '최근 작업 제목을 사용하려면 레거시 인스턴스를 재시작하세요.',
        },
    },
    en: {
        ariaLabel: 'Dashboard settings',
        eyebrow: 'Manager preferences',
        title: 'Dashboard settings',
        displayTitle: 'Instance list display',
        displayDescription: 'These controls only affect the left instance list and saved manager UI preferences.',
        activityTitle: 'Preview & activity',
        activityDescription: 'Latest activity titles depend on each instance server endpoint version.',
        embeddingTitle: 'Embedding search',
        embeddingDescription: 'Configure a vector embedding provider and manage the memory index.',
        fields: {
            activity: {
                label: 'Recent activity preview',
                scope: 'Left instance list',
                description: 'Show one cleaned line from the latest user or assistant message when the instance supports the summary endpoint.',
            },
            rename: {
                label: 'Rename control',
                scope: 'Left instance list',
                description: 'Show the pencil button for editing the dashboard-only instance label.',
            },
            runtime: {
                label: 'Runtime line',
                scope: 'Left instance list',
                description: 'Show CLI and model text, for example codex / gpt-5.5, under each instance label.',
            },
            actions: {
                label: 'Expanded row actions',
                scope: 'Selected instance row',
                description: 'Show Preview, Open, Start, Stop, and Restart buttons on the selected instance row.',
            },
            language: {
                label: 'Language',
                scope: 'Global Jaw UI',
                description: 'Sets the saved manager dashboard locale for i18n-aware surfaces.',
            },
            shortcuts: {
                label: 'Global shortcuts',
                scope: 'Manager dashboard',
                description: 'Enable Manager navigation shortcuts outside inputs and editors.',
            },
            shortcutFocusInstances: {
                label: 'Instance list',
                scope: 'Shortcut',
                description: 'Move to the Instances workspace.',
            },
            shortcutFocusActiveSession: {
                label: 'Active session',
                scope: 'Shortcut',
                description: 'Move to the selected instance Preview tab.',
            },
            shortcutFocusNotes: {
                label: 'Notes',
                scope: 'Shortcut',
                description: 'Move to the Notes workspace.',
            },
            shortcutPreviousInstance: {
                label: 'Previous instance',
                scope: 'Shortcut',
                description: 'Select the previous instance in the current filtered list.',
            },
            shortcutNextInstance: {
                label: 'Next instance',
                scope: 'Shortcut',
                description: 'Select the next instance in the current filtered list.',
            },
            shortcutResetSidebarWidth: {
                label: 'Reset sidebar width',
                scope: 'Shortcut',
                description: 'Restore the default 300px width and delete the \'jaw.sidebarWidth\' key.',
            },
        },
        support: {
            ariaLabel: 'Activity title source readiness',
            ready: 'Ready',
            legacy: 'Legacy endpoint',
            offline: 'Offline',
            empty: 'No instances are currently visible.',
            restart: 'Restart legacy instances to enable latest activity titles.',
        },
    },
    zh: {
        ariaLabel: '仪表盘设置',
        eyebrow: '管理器偏好',
        title: '仪表盘设置',
        displayTitle: '实例列表显示',
        displayDescription: '这些设置只影响左侧实例列表与已保存的管理器界面偏好。',
        activityTitle: '预览与活动',
        activityDescription: '最近活动标题取决于各实例服务器的 endpoint 版本。',
        embeddingTitle: '嵌入搜索',
        embeddingDescription: '向量嵌入 Provider 设置与内存索引管理。',
        fields: {
            activity: {
                label: '最近活动预览',
                scope: '左侧实例列表',
                description: '当实例支持摘要 endpoint 时，显示最近一条 user 或 assistant 消息整理后的单行内容。',
            },
            rename: {
                label: '重命名控件',
                scope: '左侧实例列表',
                description: '显示用于编辑仪表盘内实例标签的铅笔按钮。',
            },
            runtime: {
                label: '运行时信息行',
                scope: '左侧实例列表',
                description: '在每个实例标签下方显示 CLI 与模型信息，例如 codex / gpt-5.5。',
            },
            actions: {
                label: '展开行操作',
                scope: '已选中的实例行',
                description: '在已选中的实例行上显示 Preview、Open、Start、Stop、Restart 按钮。',
            },
            language: {
                label: '语言',
                scope: '整个 Jaw 界面',
                description: '为支持 i18n 的管理器仪表盘界面设置已保存的语言。',
            },
            shortcuts: {
                label: '全局快捷键',
                scope: 'Manager dashboard',
                description: '在输入框和编辑器外启用 Manager 导航快捷键。',
            },
            shortcutFocusInstances: {
                label: '实例列表',
                scope: '快捷键',
                description: '切换到 Instances 工作区。',
            },
            shortcutFocusActiveSession: {
                label: '活动会话',
                scope: '快捷键',
                description: '切换到已选实例的 Preview 标签。',
            },
            shortcutFocusNotes: {
                label: 'Notes',
                scope: '快捷键',
                description: '切换到 Notes 工作区。',
            },
            shortcutPreviousInstance: {
                label: '上一个实例',
                scope: '快捷键',
                description: '选择当前筛选列表中的上一个实例。',
            },
            shortcutNextInstance: {
                label: '下一个实例',
                scope: '快捷键',
                description: '选择当前筛选列表中的下一个实例。',
            },
            shortcutResetSidebarWidth: {
                label: '重置侧边栏宽度',
                scope: '快捷键',
                description: '恢复默认 300px 宽度并删除 \'jaw.sidebarWidth\' 键。',
            },
        },
        support: {
            ariaLabel: '活动标题来源就绪状态',
            ready: '就绪',
            legacy: '旧版 endpoint',
            offline: '离线',
            empty: '当前没有可显示的实例。',
            restart: '请重启旧版实例以启用最近活动标题。',
        },
    },
    ja: {
        ariaLabel: 'ダッシュボード設定',
        eyebrow: 'マネージャー環境設定',
        title: 'ダッシュボード設定',
        displayTitle: 'インスタンス一覧の表示',
        displayDescription: 'これらの設定は左側のインスタンス一覧と保存済みのマネージャー UI 設定にのみ反映されます。',
        activityTitle: 'プレビューとアクティビティ',
        activityDescription: '最近のアクティビティタイトルは各インスタンスサーバーの endpoint バージョンによって変わります。',
        embeddingTitle: 'エンベディング検索',
        embeddingDescription: 'ベクトルエンベディング Provider の設定とメモリインデックスの管理。',
        fields: {
            activity: {
                label: '最近のアクティビティのプレビュー',
                scope: '左側のインスタンス一覧',
                description: 'サマリ endpoint をサポートするインスタンスでは、直近の user または assistant メッセージを整形した 1 行を表示します。',
            },
            rename: {
                label: '名前変更コントロール',
                scope: '左側のインスタンス一覧',
                description: 'ダッシュボード専用のインスタンス表示名を編集する鉛筆ボタンを表示します。',
            },
            runtime: {
                label: 'ランタイム行',
                scope: '左側のインスタンス一覧',
                description: '各インスタンス名の下に codex / gpt-5.5 のような CLI とモデル情報を表示します。',
            },
            actions: {
                label: '展開行アクション',
                scope: '選択中のインスタンス行',
                description: '選択中のインスタンス行に Preview、Open、Start、Stop、Restart のボタンを表示します。',
            },
            language: {
                label: '言語',
                scope: 'Jaw UI 全体',
                description: 'i18n 対応のマネージャーダッシュボード画面で使用する言語を保存します。',
            },
            shortcuts: {
                label: 'グローバルショートカット',
                scope: 'Manager dashboard',
                description: '入力欄とエディタ外で Manager ナビゲーションショートカットを有効にします。',
            },
            shortcutFocusInstances: {
                label: 'インスタンス一覧',
                scope: 'ショートカット',
                description: 'Instances ワークスペースへ移動します。',
            },
            shortcutFocusActiveSession: {
                label: 'アクティブセッション',
                scope: 'ショートカット',
                description: '選択中インスタンスの Preview タブへ移動します。',
            },
            shortcutFocusNotes: {
                label: 'Notes',
                scope: 'ショートカット',
                description: 'Notes ワークスペースへ移動します。',
            },
            shortcutPreviousInstance: {
                label: '前のインスタンス',
                scope: 'ショートカット',
                description: '現在のフィルタ一覧で前のインスタンスを選択します。',
            },
            shortcutNextInstance: {
                label: '次のインスタンス',
                scope: 'ショートカット',
                description: '現在のフィルタ一覧で次のインスタンスを選択します。',
            },
            shortcutResetSidebarWidth: {
                label: 'サイドバー幅をリセット',
                scope: 'ショートカット',
                description: '既定の 300px に戻し、\'jaw.sidebarWidth\' キーを削除します。',
            },
        },
        support: {
            ariaLabel: 'アクティビティタイトル取得元の準備状態',
            ready: '準備完了',
            legacy: '旧 endpoint',
            offline: 'オフライン',
            empty: '現在表示できるインスタンスはありません。',
            restart: '最新のアクティビティタイトルを使うには、旧バージョンのインスタンスを再起動してください。',
        },
    },
} as const;

type DashboardSettingRowProps = {
    id: string;
    label: string;
    scope: string;
    description: string;
    children: ReactNode;
};

function DashboardSettingRow(props: DashboardSettingRowProps) {
    return (
        <div className="dashboard-settings-row">
            <div className="dashboard-settings-row-main">
                <label className="dashboard-settings-row-heading" htmlFor={props.id}>
                    <span>{props.label}</span>
                    <span className="dashboard-settings-row-scope">{props.scope}</span>
                </label>
                <p className="dashboard-settings-row-description">{props.description}</p>
            </div>
            <div className="dashboard-settings-row-control">
                {props.children}
            </div>
        </div>
    );
}

type DashboardSettingToggleProps = {
    id: string;
    label: string;
    scope: string;
    description: string;
    value: boolean;
    onChange: (value: boolean) => void;
};

function DashboardSettingToggle(props: DashboardSettingToggleProps) {
    return (
        <DashboardSettingRow id={props.id} label={props.label} scope={props.scope} description={props.description}>
            <input
                id={props.id}
                className="dashboard-settings-toggle"
                type="checkbox"
                checked={props.value}
                onChange={(event) => props.onChange(event.currentTarget.checked)}
            />
        </DashboardSettingRow>
    );
}

type DashboardSettingSelectProps = {
    id: string;
    label: string;
    scope: string;
    description: string;
    value: DashboardLocale;
    options: readonly { value: DashboardLocale; label: string }[];
    onChange: (value: DashboardLocale) => void;
};

type DashboardShortcutInputProps = {
    action: DashboardShortcutAction;
    label: string;
    scope: string;
    description: string;
    value: string;
    onChange: (action: DashboardShortcutAction, value: string) => void;
};

function DashboardSettingSelect(props: DashboardSettingSelectProps) {
    return (
        <DashboardSettingRow id={props.id} label={props.label} scope={props.scope} description={props.description}>
            <select
                id={props.id}
                className="dashboard-settings-select"
                value={props.value}
                onChange={(event) => props.onChange(normalizeDashboardLocale(event.currentTarget.value))}
            >
                {props.options.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                ))}
            </select>
        </DashboardSettingRow>
    );
}

function DashboardShortcutInput(props: DashboardShortcutInputProps) {
    return (
        <DashboardSettingRow id={`dashboard-shortcut-${props.action}`} label={props.label} scope={props.scope} description={props.description}>
            <input
                id={`dashboard-shortcut-${props.action}`}
                className="dashboard-settings-shortcut-input"
                type="text"
                value={props.value}
                aria-label={`${props.label} shortcut`}
                placeholder="Alt+I"
                onChange={(event) => props.onChange(props.action, event.currentTarget.value)}
            />
        </DashboardSettingRow>
    );
}

function shortcutCopyKey(action: DashboardShortcutAction): keyof typeof COPY.ko.fields {
    if (action === 'focusInstances') return 'shortcutFocusInstances';
    if (action === 'focusActiveSession') return 'shortcutFocusActiveSession';
    if (action === 'focusNotes') return 'shortcutFocusNotes';
    if (action === 'previousInstance') return 'shortcutPreviousInstance';
    if (action === 'resetSidebarWidth') return 'shortcutResetSidebarWidth';
    return 'shortcutNextInstance';
}

function TitleSupportSummary({ support, locale }: { support: DashboardActivityTitleSupport; locale: DashboardLocale }) {
    const total = support.ready + support.legacy + support.offline;
    const copy = COPY[locale].support;
    return (
        <div className="dashboard-settings-status-grid" aria-label={copy.ariaLabel}>
            <div>
                <span>{copy.ready}</span>
                <strong>{support.ready}</strong>
            </div>
            <div>
                <span>{copy.legacy}</span>
                <strong>{support.legacy}</strong>
            </div>
            <div>
                <span>{copy.offline}</span>
                <strong>{support.offline}</strong>
            </div>
            <p>{total === 0 ? copy.empty : copy.restart}</p>
        </div>
    );
}

function useDirtyStore(): DirtyStore {
    const ref = useRef<DirtyStore | null>(null);
    if (ref.current === null) ref.current = createDirtyStore();
    return ref.current;
}

function useDirtyFlag(store: DirtyStore): boolean {
    return useSyncExternalStore(
        useCallback((listener) => store.subscribe(listener), [store]),
        useCallback(() => store.isDirty(), [store]),
        useCallback(() => false, []),
    );
}

function usePendingCount(store: DirtyStore): number {
    return useSyncExternalStore(
        useCallback((listener) => store.subscribe(listener), [store]),
        useCallback(() => store.pending.size, [store]),
        useCallback(() => 0, []),
    );
}

function DashboardTelegramHubSection() {
    const dirty = useDirtyStore();
    const isDirty = useDirtyFlag(dirty);
    const pendingCount = usePendingCount(dirty);
    const client = useRef(createSettingsClient(0));
    const saveHandlerRef = useRef<SaveHandler | null>(null);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);

    const registerSave = useCallback((handler: SaveHandler | null) => {
        saveHandlerRef.current = handler;
    }, []);

    const onDiscard = useCallback(() => {
        if (saving) return;
        dirty.clear();
        setSaveError(null);
    }, [dirty, saving]);

    const onSave = useCallback(async () => {
        if (saving) return;
        const handler = saveHandlerRef.current;
        setSaveError(null);
        if (!handler) {
            dirty.clear();
            return;
        }
        setSaving(true);
        try {
            await handler();
        } catch (err) {
            setSaveError(err instanceof Error ? err.message : String(err));
        } finally {
            setSaving(false);
        }
    }, [dirty, saving]);

    return (
        <section className="dashboard-settings-section">
            <Suspense fallback={<div className="settings-loading">Loading Telegram hub...</div>}>
                <LazyTelegramHub
                    port={0}
                    instanceUrl=""
                    client={client.current}
                    dirty={dirty}
                    registerSave={registerSave}
                />
            </Suspense>
            <SaveBar
                isDirty={isDirty}
                saving={saving}
                pendingCount={pendingCount}
                error={saveError}
                onDiscard={onDiscard}
                onSave={() => void onSave()}
            />
        </section>
    );
}

export function DashboardSettingsWorkspace(props: DashboardSettingsWorkspaceProps) {
    const locale = normalizeDashboardLocale(props.ui.locale);
    const copy = COPY[locale];

    useEffect(() => {
        document.documentElement.lang = locale;
    }, [locale]);

    function patchShortcut(action: DashboardShortcutAction, value: string): void {
        props.onUiPatch({
            dashboardShortcutKeymap: {
                ...props.ui.dashboardShortcutKeymap,
                [action]: value,
            },
        });
    }

    return (
        <main className="dashboard-settings-workspace" aria-label={copy.ariaLabel}>
            <header className="dashboard-settings-header">
                <div>
                    <span className="eyebrow">{copy.eyebrow}</span>
                    <h2>{copy.title}</h2>
                </div>
                <HelpTopicButton topic="settings" label="Open Settings help" onOpen={props.onOpenHelpTopic} />
            </header>
            {props.activeSection === 'display' ? (
                <section className="dashboard-settings-section">
                    <header>
                        <h3>{copy.displayTitle}</h3>
                        <p>{copy.displayDescription}</p>
                    </header>
                    <div className="dashboard-settings-field-list">
                        <DashboardSettingToggle
                            id="dashboard-show-activity-title"
                            label={copy.fields.activity.label}
                            scope={copy.fields.activity.scope}
                            value={props.ui.showLatestActivityTitles}
                            description={copy.fields.activity.description}
                            onChange={(next) => props.onUiPatch({ showLatestActivityTitles: next })}
                        />
                        <DashboardSettingToggle
                            id="dashboard-show-label-editor"
                            label={copy.fields.rename.label}
                            scope={copy.fields.rename.scope}
                            value={props.ui.showInlineLabelEditor}
                            description={copy.fields.rename.description}
                            onChange={(next) => props.onUiPatch({ showInlineLabelEditor: next })}
                        />
                        <DashboardSettingToggle
                            id="dashboard-show-runtime-line"
                            label={copy.fields.runtime.label}
                            scope={copy.fields.runtime.scope}
                            value={props.ui.showSidebarRuntimeLine}
                            description={copy.fields.runtime.description}
                            onChange={(next) => props.onUiPatch({ showSidebarRuntimeLine: next })}
                        />
                        <DashboardSettingToggle
                            id="dashboard-show-row-actions"
                            label={copy.fields.actions.label}
                            scope={copy.fields.actions.scope}
                            value={props.ui.showSelectedRowActions}
                            description={copy.fields.actions.description}
                            onChange={(next) => props.onUiPatch({ showSelectedRowActions: next })}
                        />
                        <DashboardSettingSelect
                            id="dashboard-locale"
                            label={copy.fields.language.label}
                            scope={copy.fields.language.scope}
                            value={locale}
                            options={LOCALE_OPTIONS}
                            description={copy.fields.language.description}
                            onChange={(next) => props.onUiPatch({ locale: next })}
                        />
                        <DashboardSettingToggle
                            id="dashboard-shortcuts-enabled"
                            label={copy.fields.shortcuts.label}
                            scope={copy.fields.shortcuts.scope}
                            value={props.ui.dashboardShortcutsEnabled}
                            description={copy.fields.shortcuts.description}
                            onChange={(next) => props.onUiPatch({ dashboardShortcutsEnabled: next })}
                        />
                        {MANAGER_SHORTCUT_ACTIONS.map(action => {
                            const field = copy.fields[shortcutCopyKey(action)];
                            return (
                                <DashboardShortcutInput
                                    key={action}
                                    action={action}
                                    label={field.label}
                                    scope={field.scope}
                                    value={props.ui.dashboardShortcutKeymap[action]}
                                    description={`${field.description} Current: ${formatShortcut(props.ui.dashboardShortcutKeymap[action])}`}
                                    onChange={patchShortcut}
                                />
                            );
                        })}
                    </div>
                </section>
            ) : props.activeSection === 'activity' ? (
                <section className="dashboard-settings-section">
                    <header>
                        <h3>{copy.activityTitle}</h3>
                        <p>{copy.activityDescription}</p>
                    </header>
                    <TitleSupportSummary support={props.titleSupport} locale={locale} />
                </section>
            ) : props.activeSection === 'developer' ? (
                <DashboardDeveloperSettingsSection locale={locale} ui={props.ui} onUiPatch={props.onUiPatch} />
            ) : props.activeSection === 'telegramHub' ? (
                <DashboardTelegramHubSection />
            ) : (
                <section className="dashboard-settings-section">
                    <header>
                        <h3>{copy.embeddingTitle}</h3>
                        <p>{copy.embeddingDescription}</p>
                    </header>
                    <Suspense fallback={<p>Loading...</p>}>
                        <LazyEmbedding />
                    </Suspense>
                </section>
            )}
        </main>
    );
}
