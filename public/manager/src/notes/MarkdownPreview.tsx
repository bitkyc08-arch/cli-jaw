import { MarkdownRenderer } from './rendering/MarkdownRenderer';

type MarkdownPreviewProps = {
    markdown: string;
};

export function MarkdownPreview(props: MarkdownPreviewProps) {
    return (
        <article className="notes-preview">
            <MarkdownRenderer markdown={props.markdown} />
        </article>
    );
}
