import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readSource } from './source-normalize.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

function read(path: string): string {
    return readSource(join(projectRoot, path), 'utf8');
}

function importStatements(source: string): string[] {
    return source.match(/^import[\s\S]*?;$/gm) ?? [];
}

function jwcConversationRows(source: string): string {
    const rowStart = source.search(/\.conversations\.map\s*\(/);
    assert.notEqual(rowStart, -1, 'jwc branch must map stored conversations');
    return source.slice(rowStart, rowStart + 3_000);
}

test('dashboard2 jwc sidebar stays outside the Code lazy boundary', () => {
    const sidebar = read('public/dashboard2/src/shell/Sidebar.tsx');
    const imports = importStatements(sidebar);
    const valueCodeImports = imports.filter(statement => (
        /from\s+['"]\.\.\/code\//.test(statement)
        && !/^import\s+type\b/.test(statement)
    ));

    assert.deepEqual(valueCodeImports, [], 'Sidebar must not statically value-import from code/');
    for (const forbidden of ['code-source-adapter', 'code-event-types', 'CodeTab']) {
        assert.equal(
            imports.some(statement => statement.includes(forbidden)),
            false,
            `Sidebar must not import ${forbidden}`,
        );
    }
    assert.equal(
        imports.some(statement => statement.includes('sync-provider')),
        false,
        'Sidebar must not import the sync provider',
    );
});

test('dashboard2 jwc sidebar adds no independent transport or storage', () => {
    const sidebar = read('public/dashboard2/src/shell/Sidebar.tsx');

    assert.doesNotMatch(sidebar, /\bEventSource\b/);
    assert.doesNotMatch(sidebar, /\blocalStorage\b/);
    assert.doesNotMatch(sidebar, /new\s+WebSocket\b/);
    assert.doesNotMatch(sidebar, /\/api\/sidebar\/|\/api\/dashboard\/jwc/);

    const codeFetchUrls = [...sidebar.matchAll(/fetch\(\s*`([^`]*\/api\/code\/[^`]*)`/g)]
        .map(match => match[1]);
    assert.deepEqual(codeFetchUrls.sort(), [
        '/i/${port}/api/code/capabilities',
        '/i/${port}/api/code/sessions/stored?scope=all',
    ]);
    for (const url of codeFetchUrls) {
        assert.match(url, /^\/i\/\$\{[A-Za-z_$][\w$]*\}\/api\/code\//);
    }
});

test('dashboard2 jwc sidebar renders the complete capability and list-state matrix', () => {
    const sidebar = read('public/dashboard2/src/shell/Sidebar.tsx');

    for (const state of ['missing_binary', 'acp_unsupported', 'temporarily_unavailable']) {
        assert.ok(sidebar.includes(state), `Sidebar must handle ${state}`);
    }
    assert.match(sidebar, /jwcState\.loading[\s\S]*?d2-spinner[\s\S]*?Loading (?:Code sessions|jwc conversations)/i);
    assert.ok(sidebar.includes('No jwc conversations'), 'Sidebar must keep an explicit empty state');
    assert.match(sidebar, /missing_binary[\s\S]*?(?:install|not installed|unavailable)/i);
    assert.match(sidebar, /acp_unsupported[\s\S]*?(?:update|unsupported|support)/i);
    assert.match(sidebar, /temporarily_unavailable[\s\S]*?(?:retry|temporarily|unavailable)/i);
    assert.doesNotMatch(sidebar, /console\.error\s*\(/);
    assert.doesNotMatch(
        sidebar,
        /(?:missing_binary|acp_unsupported|temporarily_unavailable)[^\n]*(?:throw\b|console\.error)/,
    );
});

test('dashboard2 jwc conversations use the existing two-line row vocabulary', () => {
    const sidebar = read('public/dashboard2/src/shell/Sidebar.tsx');
    const rows = jwcConversationRows(sidebar);

    assert.match(rows, /d2-instance-row/);
    assert.match(rows, /d2-instance-main/);
    assert.match(rows, /d2-instance-copy/);
    assert.match(rows, /d2-(?:instance|jwc)[\w-]*dot/);
    assert.match(rows, /<strong(?:\s[^>]*)?>[\s\S]*?<\/strong>/);
    assert.match(rows, /<strong(?:\s[^>]*)?>[\s\S]*?<\/strong>[\s\S]*?<span(?:\s[^>]*)?>/);
});

test('dashboard2 jwc conversation selection opens the side pane', () => {
    const sidebar = read('public/dashboard2/src/shell/Sidebar.tsx');
    const rows = jwcConversationRows(sidebar);

    assert.match(sidebar, /useAppScope\(\)/);
    assert.match(rows, /onClick=\{[\s\S]{0,600}?openSidePane\(\)/);
});

test('dashboard2 jwc conversation rows are keyboard and status accessible', () => {
    const sidebar = read('public/dashboard2/src/shell/Sidebar.tsx');
    const rows = jwcConversationRows(sidebar);

    assert.match(rows, /<button\b/);
    assert.match(rows, /<button[\s\S]{0,500}?type="button"/);
    assert.match(
        rows,
        /d2-(?:instance|jwc)[\w-]*dot[\s\S]{0,250}?(?:aria-hidden|aria-label|role=)/,
        'conversation status dot must be hidden from or described to assistive technology',
    );
});
