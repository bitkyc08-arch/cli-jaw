import { createPortal } from 'react-dom';
import { MarkdownRenderer } from '../rendering/MarkdownRenderer';
import type { RichMarkdownWidgetRegistration } from './rich-markdown-types';

type RichMarkdownPortalHostProps = {
    widgets: RichMarkdownWidgetRegistration[];
};

export function RichMarkdownPortalHost(props: RichMarkdownPortalHostProps) {
    return (
        <>
            {props.widgets.map(widget => createPortal(
                <MarkdownRenderer markdown={widget.markdown} />,
                widget.shell,
                widget.id,
            ))}
        </>
    );
}

