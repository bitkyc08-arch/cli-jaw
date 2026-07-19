export type DockTabKind = 'agents' | 'skills' | 'settings';

export const DOCK_TAB_KINDS: DockTabKind[] = ['agents', 'skills', 'settings'];

export const DOCK_TAB_TITLES: Record<DockTabKind, string> = {
    agents: '에이전트',
    skills: '스킬',
    settings: '설정',
};

export type HoverDockProps = {
    port: number | null;
    locale?: string | undefined;
};
