export type RenderLocale = 'ko' | 'en';
export type RenderCopyKey =
    | 'tool.expand' | 'tool.collapse' | 'tool.status.running' | 'tool.status.ran'
    | 'tool.status.error' | 'tool.label' | 'tool.labelPlain' | 'widget.expand'
    | 'widget.collapse' | 'widget.state.expanded' | 'widget.state.collapsed'
    | 'turn.title' | 'stream.oversizeNotice' | 'stream.renderFully'
    | 'stream.fencePlaceholder' | 'stream.mathPlaceholder';

export const renderCopyCatalog: Record<RenderLocale, Record<RenderCopyKey, string>> = {
    ko: {
        'tool.expand': '도구 펼치기', 'tool.collapse': '도구 접기',
        'tool.status.running': '실행 중', 'tool.status.ran': '실행됨', 'tool.status.error': '오류',
        'tool.label': '도구 {seq}', 'tool.labelPlain': '도구',
        'widget.expand': '위젯 펼치기', 'widget.collapse': '위젯 접기',
        'widget.state.expanded': '펼쳐짐', 'widget.state.collapsed': '접힘',
        'turn.title': '턴', 'stream.oversizeNotice': '큰 응답({sizeKiB} KiB)은 안정된 부분까지만 표시합니다.',
        'stream.renderFully': '전체 렌더링', 'stream.fencePlaceholder': '열린 코드 블록',
        'stream.mathPlaceholder': '열린 수식',
    },
    en: {
        'tool.expand': 'Expand tool', 'tool.collapse': 'Collapse tool',
        'tool.status.running': 'Running', 'tool.status.ran': 'Ran', 'tool.status.error': 'Error',
        'tool.label': 'Tool {seq}', 'tool.labelPlain': 'Tool',
        'widget.expand': 'Expand widget', 'widget.collapse': 'Collapse widget',
        'widget.state.expanded': 'Expanded', 'widget.state.collapsed': 'Collapsed',
        'turn.title': 'Turn', 'stream.oversizeNotice': 'Large response ({sizeKiB} KiB) is showing its last stable render.',
        'stream.renderFully': 'Render fully', 'stream.fencePlaceholder': 'Open code block',
        'stream.mathPlaceholder': 'Open math block',
    },
};

export function renderCopy(locale: RenderLocale, key: RenderCopyKey, vars: Record<string, string | number> = {}): string {
    return renderCopyCatalog[locale][key].replace(/\{(\w+)\}/g, (match, name: string) =>
        Object.hasOwn(vars, name) ? String(vars[name]) : match);
}
