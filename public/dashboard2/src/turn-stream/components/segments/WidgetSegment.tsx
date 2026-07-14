import { Box, ChevronDown, ChevronRight } from '@lucide/icons';
import type { CSSProperties, JSX, ReactNode } from 'react';
import { Icon } from '../../../shell/Icon.tsx';
import { usePreferences } from '../../../providers/preferences-provider.tsx';
import { renderCopy } from '../../render/copy-catalog.ts';

export interface WidgetDescriptor {
    widgetId: string;
    title: string;
    estimatedHeight: number;
}

export interface WidgetSegmentProps {
    descriptor: WidgetDescriptor;
    expanded: boolean;
    onToggle(): void;
    children?: ReactNode;
}

type WidgetStyle = CSSProperties & { '--d2-widget-estimated-height': string };

export function WidgetSegment({
    descriptor,
    expanded,
    onToggle,
    children,
}: WidgetSegmentProps): JSX.Element {
    const { locale } = usePreferences();
    const renderLocale = locale.locale === 'ko' ? 'ko' : 'en';
    const estimatedHeight = Math.max(1, Math.trunc(descriptor.estimatedHeight));
    const style: WidgetStyle = { '--d2-widget-estimated-height': `${estimatedHeight}px` };

    return (
        <div
            className={`d2-widget-segment${expanded ? ' is-expanded' : ''}`}
            data-widget-id={descriptor.widgetId}
            style={style}
        >
            <button
                type="button"
                className="d2-segment-toggle"
                aria-expanded={expanded}
                aria-label={`${renderCopy(renderLocale, expanded ? 'widget.collapse' : 'widget.expand')} ${descriptor.title}`}
                onClick={onToggle}
            >
                <Icon icon={Box} size={14} />
                <span className="d2-segment-label">{descriptor.title}</span>
                <span className="d2-widget-state">{renderCopy(renderLocale, expanded ? 'widget.state.expanded' : 'widget.state.collapsed')}</span>
                <Icon icon={expanded ? ChevronDown : ChevronRight} size={13} />
            </button>
            {expanded ? <div className="d2-widget-frame" data-widget-frame>{children}</div> : null}
        </div>
    );
}
