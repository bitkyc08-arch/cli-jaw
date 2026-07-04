import type { RightSidebarOpenTab } from './types';
import { RIGHT_SIDEBAR_TAB_TITLES } from './types';

export type RightSidebarTabDisplay = {
    visibleLabel: string;
    title: string;
    ariaLabel: string;
};

/**
 * Centralized tab-label resolver (020B).
 *
 * - Visible label: the concrete instance name (specificName).
 * - Tooltip/title and ARIA carry both the kind and the full specific detail
 *   (sourceLabel when available, e.g. a full path or URL).
 * - The kind icon is derived from tab.kind at render time and never persisted.
 */
export function getRightSidebarTabDisplay(tab: RightSidebarOpenTab): RightSidebarTabDisplay {
    const kindTitle = RIGHT_SIDEBAR_TAB_TITLES[tab.kind];
    const detail = tab.sourceLabel ?? tab.specificName;
    return {
        visibleLabel: tab.specificName,
        title: `${kindTitle}: ${detail}`,
        ariaLabel: `${kindTitle} tab, ${detail}`,
    };
}

/**
 * Density class for the equal-width tab strip. Content inside each tab adapts
 * as the strip gets crowded; row height and the '+' location stay stable.
 */
export function getRightSidebarTabDensity(openTabCount: number): 'comfortable' | 'compact' | 'mini' {
    if (openTabCount <= 2) return 'comfortable';
    if (openTabCount <= 4) return 'compact';
    return 'mini';
}
