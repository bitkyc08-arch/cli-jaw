// ── Tool UI Tests ──
// Tests the REAL buildToolGroupHtml from public/js/features/tool-ui.ts
// render.js is mocked to avoid pulling in marked/highlight.js browser deps.

import { describe, it, mock, before } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const RENDER_PATH = resolve(ROOT, 'public/js/render.js');

let buildToolGroupHtml: typeof import('../../public/js/features/tool-ui.ts').buildToolGroupHtml;

before(async () => {
    // Mock render.js — only escapeHtml is used by tool-ui.ts
    // Reproduces the exact 5-replacement chain from render.ts L73-75
    mock.module(RENDER_PATH, {
        namedExports: {
            escapeHtml: (s: string) =>
                s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
        },
    });
    const mod = await import('../../public/js/features/tool-ui.ts');
    buildToolGroupHtml = mod.buildToolGroupHtml;
});

describe('tool-ui', () => {
    describe('buildToolGroupHtml', () => {
        it('returns empty string for empty array', () => {
            assert.equal(buildToolGroupHtml([]), '');
        });

        it('returns empty string for null/undefined', () => {
            assert.equal(buildToolGroupHtml(null as any), '');
            assert.equal(buildToolGroupHtml(undefined as any), '');
        });

        it('renders single tool entry with correct structure', () => {
            const html = buildToolGroupHtml([{ icon: '🔍', label: 'Search' }]);
            // Outer wrapper
            assert.match(html, /^<div class="tool-group">/);
            // Summary button with ARIA
            assert.match(html, /aria-expanded="false"/);
            assert.match(html, /aria-controls="td-\d+"/);
            // Icon count in summary (× replaced with &times;)
            assert.ok(html.includes('🔍&times;1'));
            // Tool item label
            assert.ok(html.includes('<span class="tool-item-label">Search</span>'));
        });

        it('aria-controls matches details id', () => {
            const html = buildToolGroupHtml([{ icon: '🔍', label: 'test' }]);
            const controlsMatch = html.match(/aria-controls="(td-\d+)"/);
            const idMatch = html.match(/id="(td-\d+)"/);
            assert.ok(controlsMatch, 'aria-controls attribute missing');
            assert.ok(idMatch, 'details id attribute missing');
            assert.equal(controlsMatch![1], idMatch![1], 'aria-controls must match details id');
        });

        it('renders multiple entries with same icon — count aggregated', () => {
            const html = buildToolGroupHtml([
                { icon: '📄', label: 'Read file A' },
                { icon: '📄', label: 'Read file B' },
            ]);
            assert.ok(html.includes('📄&times;2'));
            assert.ok(html.includes('Read file A'));
            assert.ok(html.includes('Read file B'));
            // Exactly 2 tool-items
            assert.equal(html.match(/class="tool-item"/g)?.length, 2);
        });

        it('renders mixed icons with correct counts', () => {
            const html = buildToolGroupHtml([
                { icon: '🔍', label: 'Search 1' },
                { icon: '📄', label: 'Read 1' },
                { icon: '🔍', label: 'Search 2' },
                { icon: '✏️', label: 'Edit 1' },
            ]);
            assert.ok(html.includes('🔍&times;2'));
            assert.ok(html.includes('📄&times;1'));
            assert.ok(html.includes('✏️&times;1'));
            assert.equal(html.match(/class="tool-item"/g)?.length, 4);
        });

        it('escapes HTML in icon and label (XSS prevention)', () => {
            const html = buildToolGroupHtml([{ icon: '<script>', label: "a<b>'c" }]);
            // Escaped forms present
            assert.ok(html.includes('&lt;script&gt;&times;1'));
            assert.ok(html.includes('a&lt;b&gt;&#39;c'));
            // Raw dangerous strings absent
            assert.ok(!html.includes('<script>×'), 'raw <script> must be escaped');
            assert.ok(!html.includes("'c"), "single quote must be escaped to &#39;");
        });

        it('renders collapsed details by default', () => {
            const html = buildToolGroupHtml([{ icon: '🔍', label: 'test' }]);
            assert.ok(html.includes('class="tool-details collapsed"'));
        });

        it('generates unique toolId using Date.now()', () => {
            const before = Date.now();
            const html = buildToolGroupHtml([{ icon: '🔍', label: 'test' }]);
            const after = Date.now();
            const idMatch = html.match(/id="td-(\d+)"/);
            assert.ok(idMatch, 'toolId must contain numeric timestamp');
            const ts = Number(idMatch![1]);
            assert.ok(ts >= before && ts <= after, `toolId timestamp ${ts} outside [${before}, ${after}]`);
        });

        it('chevron indicator present in summary', () => {
            const html = buildToolGroupHtml([{ icon: '🔍', label: 'test' }]);
            assert.ok(html.includes('class="tool-group-chevron"'), 'chevron wrapper must exist');
            assert.ok(html.includes('lucide'), 'chevron must use Lucide SVG icon');
        });

        it('done status dot present in summary', () => {
            const html = buildToolGroupHtml([{ icon: '🔍', label: 'test' }]);
            assert.ok(html.includes('<span class="tool-status-dot done"></span>'));
        });
    });
});
