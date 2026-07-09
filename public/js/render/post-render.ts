// ── Batched post-render scheduler ──
import { renderMermaidBlocks } from './mermaid.js';
import { rehighlightAll } from './highlight.js';
import { bindDiagramZoom } from './svg-actions.js';
import { linkifyFilePathsWithNotesRoot } from './file-links.js';
import { hydrateElicitationBlocks } from '../features/elicitation.js';
import { hydrateSearchResultsBlocks } from './search-results.js';
import { hydrateComposeBlocks } from './compose-block.js';
import { hydrateDataframeBlocks } from './dataframe.js';
import { hydrateChartJsonBlocks } from './chart-json.js';
import { hydrateLinkPreviewCards } from './link-preview.js';

let postRenderRAF: number | null = null;
let postRenderTimer: ReturnType<typeof setTimeout> | null = null;

export function schedulePostRender(): void {
    if (postRenderTimer) clearTimeout(postRenderTimer);
    if (postRenderRAF) { cancelAnimationFrame(postRenderRAF); postRenderRAF = null; }
    postRenderTimer = setTimeout(() => {
        postRenderTimer = null;
        postRenderRAF = requestAnimationFrame(() => {
            postRenderRAF = null;
            const msgContainer = document.getElementById('chatMessages');
            // Cheap guards (devlog 260705_frontend_perf M1): these three walk
            // the whole container; skip when no candidate nodes exist. The
            // hydrate* calls below stay unconditional — each is already a
            // scoped selector scan and their call shape is a renderer contract.
            if (!msgContainer || msgContainer.querySelector('.mermaid-pending, [data-mermaid-code-raw]')) renderMermaidBlocks();
            if (!msgContainer || msgContainer.querySelector('.code-block pre code, .code-block-wrapper pre code')) rehighlightAll();
            if (!msgContainer || msgContainer.querySelector('.diagram-zoom-btn, .mermaid-zoom-btn')) bindDiagramZoom();
            if (msgContainer) {
                hydrateElicitationBlocks(msgContainer);
                hydrateSearchResultsBlocks(msgContainer);
                hydrateComposeBlocks(msgContainer);
                hydrateDataframeBlocks(msgContainer);
                hydrateChartJsonBlocks(msgContainer);
                hydrateLinkPreviewCards(msgContainer);
                void linkifyFilePathsWithNotesRoot(msgContainer);
            }
        });
    }, 100);
}

export function cancelPostRender(): void {
    if (postRenderTimer) {
        clearTimeout(postRenderTimer);
        postRenderTimer = null;
    }
    if (postRenderRAF) {
        cancelAnimationFrame(postRenderRAF);
        postRenderRAF = null;
    }
}
