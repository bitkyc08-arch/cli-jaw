import type { DesignPageSummary } from './design-types';

type DesignPageSelectorProps = {
    pages: DesignPageSummary[];
    selectedPageId: string | null;
    disabled: boolean;
    onSelect: (pageId: string | null) => void;
};

/** Center-toolbar page dropdown: `<title> · N pages` (186 panel contract). */
export function DesignPageSelector(props: DesignPageSelectorProps) {
    return (
        <select
            className="design-page-selector"
            aria-label={`Design pages (${props.pages.length})`}
            title={`${props.pages.length} pages`}
            disabled={props.disabled || props.pages.length === 0}
            value={props.selectedPageId ?? ''}
            onChange={event => props.onSelect(event.target.value || null)}
        >
            {props.pages.length === 0 && <option value="">No pages</option>}
            {props.pages.map(page => (
                <option key={page.id} value={page.id}>{page.title}</option>
            ))}
        </select>
    );
}
