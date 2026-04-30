import { isValidElement } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import rehypeSanitize from 'rehype-sanitize';
import remarkMath from 'remark-math';
import { CodeBlock } from './CodeBlock';
import { MermaidBlock } from './MermaidBlock';
import {
    isSafeExternalHref,
    markdownSanitizeSchema,
    safeMarkdownUrl,
} from './markdown-render-security';

type MarkdownRendererProps = {
    markdown: string;
};

function textFromNode(node: ReactNode): string {
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(textFromNode).join('');
    if (isValidElement<{ children?: ReactNode }>(node)) return textFromNode(node.props.children);
    return '';
}

function languageFromCodeNode(node: ReactNode): string {
    if (!isValidElement<{ className?: string }>(node)) return 'text';
    const className = node.props.className ?? '';
    const match = className.match(/language-([^\s]+)/);
    return match?.[1] ?? 'text';
}

export function MarkdownRenderer(props: MarkdownRendererProps) {
    return (
        <ReactMarkdown
            skipHtml
            urlTransform={safeMarkdownUrl}
            remarkPlugins={[remarkMath]}
            rehypePlugins={[
                [rehypeSanitize, markdownSanitizeSchema],
                rehypeKatex,
            ]}
            components={{
                a: ({ href, children }) => {
                    const safeHref = typeof href === 'string' && isSafeExternalHref(href) ? href : undefined;
                    const external = Boolean(safeHref && /^https?:\/\//i.test(safeHref));
                    return (
                        <a
                            href={safeHref}
                            target={external ? '_blank' : undefined}
                            rel={external ? 'noreferrer noopener' : undefined}
                        >
                            {children}
                        </a>
                    );
                },
                code: ({ className, children }: ComponentProps<'code'>) => (
                    <code className={className}>{children}</code>
                ),
                pre: ({ children }) => {
                    const language = languageFromCodeNode(children);
                    const code = textFromNode(children).replace(/\n$/, '');
                    if (language === 'mermaid') return <MermaidBlock code={code} />;
                    return <CodeBlock code={code} language={language} />;
                },
            }}
        >
            {props.markdown}
        </ReactMarkdown>
    );
}
