export const xssNegativeFixtures = [
    '<script>alert(1)</script>', '<iframe src="https://evil.test"></iframe>', '<style>body{display:none}</style>',
    '<img src=x onerror=alert(1)>', '<a href="javascript:alert(1)">x</a>', '<a href="data:text/html,x">x</a>',
    '<svg onload=alert(1)></svg>', '<button onclick=alert(1)>dialog</button>', '<form action="javascript:alert(1)"><button>go</button></form>',
] as const;

export const xssPositiveFixtures = {
    markdown: '<a href="./safe/path">relative</a><a href="https://example.com">https</a><a href="mailto:a@example.com">mail</a>',
    highlight: '<pre data-language="ts"><code class="language-ts"><span class="token keyword" data-syntax-token="keyword">const</span></code></pre>',
} as const;
