import { Box, ChevronDown, ChevronRight } from '@lucide/icons';
import { useEffect, useSyncExternalStore, type CSSProperties, type JSX, type ReactNode } from 'react';
import { Icon } from '../../../shell/Icon.tsx';
import { usePreferences } from '../../../providers/preferences-provider.tsx';
import { renderCopy } from '../../render/copy-catalog.ts';
import {
    createWidgetPanelPayload,
    type WidgetPromotionSource,
} from '../../widgets/widget-panel-key.ts';
import type { WidgetDescriptor } from '../../widgets/widget-segment-adapter.ts';
import { widgetUiStore } from '../../widgets/widget-ui-store.ts';
import { WidgetRuntime } from '../../widgets/WidgetRuntime.tsx';

export interface WidgetSegmentProps {
    descriptor: Pick<WidgetDescriptor, 'title' | 'estimatedHeight'> & Partial<WidgetDescriptor>;
    expanded: boolean;
    onToggle(): void;
    chatId?: string;
    identity?: { scopeKey: string; turnId: string; segmentId: string };
    promotionSource?: WidgetPromotionSource;
    children?: ReactNode;
}

type WidgetStyle = CSSProperties & { '--d2-widget-estimated-height': string };

export function WidgetSegment({
    descriptor,
    expanded,
    onToggle,
    chatId,
    identity,
    promotionSource,
    children,
}: WidgetSegmentProps): JSX.Element {
    const { locale } = usePreferences();
    const renderLocale = locale.locale === 'ko' ? 'ko' : 'en';
    const estimatedHeight = Math.max(1, Math.trunc(descriptor.estimatedHeight));
    const style: WidgetStyle = { '--d2-widget-estimated-height': `${estimatedHeight}px` };
    const promotion = createWidgetPanelPayload(promotionSource, chatId, descriptor, identity);
    const widgetSnapshot = useSyncExternalStore(
        widgetUiStore.subscribe,
        widgetUiStore.getSnapshot,
        widgetUiStore.getSnapshot,
    );
    const panelState = promotion ? widgetSnapshot[promotion.panelKey] : undefined;
    const panelOwned = panelState?.mode === 'panel' || panelState?.handoff === 'mounting';
    const handoffPending = panelState !== undefined && panelState.handoff !== 'idle';
    const inlineExpanded = !panelOwned && (promotion && panelState ? panelState.mode === 'inline' : expanded);
    const panelAction = panelState?.mode === 'panel'
        ? (renderLocale === 'ko' ? '위젯 패널 다시 열기' : 'Reopen widget panel')
        : (renderLocale === 'ko' ? '위젯을 패널로 열기' : 'Open widget in panel');

    useEffect(() => {
        if (!promotion || panelState) return;
        if (expanded) widgetUiStore.expand(promotion.panelKey, promotion.rowKey);
        else widgetUiStore.collapse(promotion.panelKey, promotion.rowKey);
    }, [expanded, panelState, promotion]);

    function toggleInline(): void {
        if (promotion) {
            if (inlineExpanded) {
                widgetUiStore.collapse(
                    promotion.panelKey,
                    promotion.rowKey,
                    `${promotion.rowKey}|${promotion.descriptor.revision}`,
                );
            } else widgetUiStore.expand(promotion.panelKey, promotion.rowKey);
        }
        onToggle();
    }

    function requestPromotion(): void {
        if (!promotion) return;
        widgetUiStore.requestPromotion(promotion, inlineExpanded ? 'inline' : 'placeholder');
    }

    return (
        <div
            className={`d2-widget-segment${inlineExpanded ? ' is-expanded' : ''}`}
            data-widget-id={descriptor.widgetId ?? identity?.segmentId ?? 'inline'}
            data-widget-mode={panelOwned ? 'panel' : inlineExpanded ? 'inline' : 'placeholder'}
            style={style}
        >
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <button
                    type="button"
                    className="d2-segment-toggle"
                    style={{ flex: 1, minWidth: 0 }}
                    aria-expanded={inlineExpanded}
                    aria-label={`${renderCopy(renderLocale, inlineExpanded ? 'widget.collapse' : 'widget.expand')} ${descriptor.title}`}
                    onClick={toggleInline}
                    disabled={panelOwned || handoffPending}
                >
                    <Icon icon={Box} size={14} />
                    <span className="d2-segment-label">{descriptor.title}</span>
                    <span className="d2-widget-state">{panelOwned
                        ? (renderLocale === 'ko' ? '패널에서 열림' : 'Open in panel')
                        : renderCopy(renderLocale, inlineExpanded ? 'widget.state.expanded' : 'widget.state.collapsed')}</span>
                    <Icon icon={inlineExpanded ? ChevronDown : ChevronRight} size={13} />
                </button>
                {promotion ? <button
                    type="button"
                    className="d2-widget-state"
                    aria-label={panelAction}
                    title={panelAction}
                    onClick={requestPromotion}
                    disabled={handoffPending}
                    style={{ flex: 'none', border: 0, background: 'transparent', cursor: handoffPending ? 'default' : 'pointer' }}
                >{panelState?.mode === 'panel' ? (renderLocale === 'ko' ? '다시 열기' : 'Reopen') : (renderLocale === 'ko' ? '패널' : 'Panel')}</button> : null}
            </div>
            {inlineExpanded ? <div className="d2-widget-frame" data-widget-frame>
                {children ?? (chatId && identity && descriptor.storage && descriptor.revision && descriptor.capabilities
                    ? <WidgetRuntime descriptor={descriptor as WidgetDescriptor} chatId={chatId} identity={identity} /> : null)}
            </div> : null}
        </div>
    );
}
