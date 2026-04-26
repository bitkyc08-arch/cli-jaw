import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const projectRoot = join(import.meta.dirname, '../..');
const renderSrc = readFileSync(join(projectRoot, 'public/js/render.ts'), 'utf8');

// ── Test the regex fallback sanitizer (server-side, no DOMPurify) ──
// In the browser, DOMPurify handles sanitization.
// Here we test the regex fallback path that runs when DOMPurify is unavailable.

function sanitizeHtmlFallback(html) {
    return html
        .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
        .replace(/\bon\w+\s*=/gi, 'data-removed=')
        .replace(/javascript\s*:/gi, 'about:blank');
}

describe('render sanitize (regex fallback)', () => {
    it('should strip <script> tags', () => {
        const input = '<p>Hello</p><script>alert("xss")</script><p>World</p>';
        const result = sanitizeHtmlFallback(input);
        assert.ok(!result.includes('<script'), 'script tag should be removed');
        assert.ok(result.includes('<p>Hello</p>'), 'normal tags preserved');
        assert.ok(result.includes('<p>World</p>'), 'normal tags preserved');
    });

    it('should strip multiline <script> blocks', () => {
        const input = `<div>Safe</div><script type="text/javascript">
            var x = 1;
            alert(x);
        </script><div>Also safe</div>`;
        const result = sanitizeHtmlFallback(input);
        assert.ok(!result.includes('<script'), 'multiline script removed');
        assert.ok(result.includes('Safe'), 'content preserved');
    });

    it('should neutralize inline event handlers', () => {
        const input = '<img src="x" onerror="alert(1)">';
        const result = sanitizeHtmlFallback(input);
        assert.ok(!result.includes('onerror='), 'onerror should be removed');
        assert.ok(result.includes('data-removed='), 'replaced with data-removed');
    });

    it('should neutralize onclick handlers', () => {
        const input = '<div onclick="steal()">Click me</div>';
        const result = sanitizeHtmlFallback(input);
        assert.ok(!result.includes('onclick='), 'onclick should be removed');
    });

    it('should neutralize onload handlers', () => {
        const input = '<body onload="init()">';
        const result = sanitizeHtmlFallback(input);
        assert.ok(!result.includes('onload='), 'onload should be removed');
    });

    it('should neutralize javascript: URLs', () => {
        const input = '<a href="javascript:alert(1)">Click</a>';
        const result = sanitizeHtmlFallback(input);
        assert.ok(!result.includes('javascript:'), 'javascript: protocol removed');
        assert.ok(result.includes('about:blank'), 'replaced with about:blank');
    });

    it('should handle case-insensitive javascript: URLs', () => {
        const input = '<a href="JavaScript:void(0)">Link</a>';
        const result = sanitizeHtmlFallback(input);
        assert.ok(!result.toLowerCase().includes('javascript:'), 'case-insensitive match');
    });

    it('should preserve normal HTML content', () => {
        const input = '<div class="wrapper"><p>Hello <strong>World</strong></p><code>x = 1</code></div>';
        const result = sanitizeHtmlFallback(input);
        assert.equal(result, input, 'safe HTML should be unchanged');
    });

    it('should preserve code blocks with angle brackets', () => {
        const input = '<pre><code>&lt;script&gt;not real&lt;/script&gt;</code></pre>';
        const result = sanitizeHtmlFallback(input);
        assert.equal(result, input, 'escaped HTML entities in code blocks preserved');
    });

    it('should preserve tables', () => {
        const input = '<table><tr><th>Header</th></tr><tr><td>Cell</td></tr></table>';
        const result = sanitizeHtmlFallback(input);
        assert.equal(result, input, 'table HTML preserved');
    });

    it('should handle multiple attack vectors in one string', () => {
        const input = '<p>Safe</p><script>bad()</script><img onerror="x"><a href="javascript:y">z</a>';
        const result = sanitizeHtmlFallback(input);
        assert.ok(!result.includes('<script'), 'script removed');
        assert.ok(!result.includes('onerror='), 'onerror removed');
        assert.ok(!result.includes('javascript:'), 'javascript: removed');
        assert.ok(result.includes('<p>Safe</p>'), 'safe content preserved');
    });
});

describe('prompt leakage redaction contract', () => {
    it('should define a dedicated orchestration prompt leak stripper', () => {
        assert.ok(renderSrc.includes('export function stripPromptLeakage'));
        assert.ok(renderSrc.includes('## Approved Plan'));
        assert.ok(renderSrc.includes('[PABCD'));
        assert.ok(renderSrc.includes('[PLANNING MODE'));
        assert.ok(renderSrc.includes('[PLAN AUDIT'));
    });

    it('should run prompt leakage stripping through stripOrchestration', () => {
        const stripIdx = renderSrc.indexOf('export function stripOrchestration');
        const callIdx = renderSrc.indexOf('stripPromptLeakage(cleaned)', stripIdx);
        assert.ok(stripIdx > -1);
        assert.ok(callIdx > stripIdx);
    });

    it('should not redact every casual Approved Plan mention', () => {
        assert.ok(renderSrc.includes('PROMPT_LEAK_START'), 'redaction must be marker based');
        assert.ok(
            !renderSrc.includes('/Approved Plan/'),
            'redaction should not be a broad Approved Plan substring replace',
        );
    });
});
