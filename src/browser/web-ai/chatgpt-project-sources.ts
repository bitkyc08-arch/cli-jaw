import { existsSync, statSync, realpathSync } from 'node:fs';
import { resolve, basename } from 'node:path';

// Parity catalog 102 (chatgpt-project-sources). Strict-TS port of agbrowse
// web-ai/chatgpt-project-sources.mjs. Reader+writer for ChatGPT project (/g/<id>)
// source files — distinct from cli-jaw product-surfaces.ts (read-only detection).
// URL/file validation (validateProjectSourcesUrl / validateProjectSourceFiles) and
// the page-side expression builders are pure/testable; list/add drive CDP.

/** Minimal CDP session shape (cli-jaw's BrowserCdpSession is module-private). */
export interface CdpSendSession {
    send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface ProjectSource {
    name: string;
    type: string;
}

export interface ProjectUploadResult {
    name: string;
    type: string;
    uploaded: boolean;
}

const PROJECT_URL_PATTERN = /^https:\/\/chatgpt\.com\/g\/[a-zA-Z0-9_-]+/;

const SOURCE_ENTRY_SELECTORS = [
    '[data-testid="project-source-item"]',
    '[class*="source-item"]',
    '.project-source-entry',
];

const ADD_SOURCE_SELECTORS = [
    'button[data-testid="add-source"]',
    'button:has-text("Add source")',
    'button:has-text("Upload")',
    'button[aria-label*="Add" i]',
];

/** Validate a ChatGPT project URL (https://chatgpt.com/g/<id>). */
export function validateProjectSourcesUrl(url: string): { ok: boolean; error?: string } {
    if (!url) return { ok: false, error: 'project URL is required' };
    if (!PROJECT_URL_PATTERN.test(url)) {
        return { ok: false, error: `not a valid ChatGPT project URL: ${url}` };
    }
    return { ok: true };
}

/** Validate local file paths for upload: existence, realpath, regular-file, size cap. */
export function validateProjectSourceFiles(
    filePaths: string[],
    options: { cwd?: string; maxFileSize?: number } = {},
): { valid: Array<{ path: string; name: string; size: number }>; errors: string[] } {
    const valid: Array<{ path: string; name: string; size: number }> = [];
    const errors: string[] = [];
    const maxSize = Number.isFinite(options.maxFileSize) ? Number(options.maxFileSize) : 512 * 1024 * 1024;
    const cwd = options.cwd || process.cwd();

    for (const fp of filePaths) {
        const abs = resolve(cwd, fp);
        if (!existsSync(abs)) {
            errors.push(`file not found: ${fp}`);
            continue;
        }
        let real: string;
        try {
            real = realpathSync(abs);
        } catch {
            errors.push(`cannot resolve realpath: ${fp}`);
            continue;
        }
        const stat = statSync(real);
        if (!stat.isFile()) {
            errors.push(`not a regular file: ${fp}`);
            continue;
        }
        if (stat.size > maxSize) {
            errors.push(`file too large (${stat.size} bytes, max ${maxSize}): ${fp}`);
            continue;
        }
        valid.push({ path: real, name: basename(real), size: stat.size });
    }
    return { valid, errors };
}

export function buildProjectSourcesListExpression(): string {
    return `(() => {
        const selectors = ${JSON.stringify(SOURCE_ENTRY_SELECTORS)};
        for (const sel of selectors) {
            const els = document.querySelectorAll(sel);
            if (els.length) {
                return JSON.stringify(Array.from(els).map(el => ({
                    name: el.textContent?.trim() || '',
                    type: el.getAttribute('data-type') || 'file',
                })).filter(row => row.name));
            }
        }
        return '[]';
    })()`;
}

export function buildProjectSourcesUploadEvidenceExpression(fileNames: string[]): string {
    return `(() => {
        const expected = ${JSON.stringify(fileNames)};
        const text = document.body?.innerText || '';
        const present = expected.filter(name => text.includes(name));
        const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
        const inputFileCount = fileInputs.reduce((sum, input) => sum + (input.files?.length || 0), 0);
        return JSON.stringify({
            expected,
            present,
            inputFileCount,
            ok: present.length === expected.length || inputFileCount >= expected.length,
        });
    })()`;
}

async function evaluateJsonExpression(cdpSession: CdpSendSession, expression: string): Promise<unknown> {
    const res = (await cdpSession.send('Runtime.evaluate', { expression, returnByValue: true })) as {
        result?: { value?: unknown };
    };
    const value = res?.result?.value;
    if (!value) return null;
    return JSON.parse(String(value));
}

/** List project sources from a ChatGPT project. */
export async function listProjectSources(
    cdpSession: CdpSendSession,
    { projectUrl }: { projectUrl: string },
): Promise<{ ok: boolean; sources: ProjectSource[]; warnings: string[] }> {
    const urlCheck = validateProjectSourcesUrl(projectUrl);
    if (!urlCheck.ok) {
        return { ok: false, sources: [], warnings: [urlCheck.error || 'invalid-url'] };
    }

    try {
        await cdpSession.send('Page.enable');
        await cdpSession.send('Page.navigate', { url: projectUrl });
        await new Promise((r) => setTimeout(r, 3000));

        const sources = ((await evaluateJsonExpression(cdpSession, buildProjectSourcesListExpression())) as ProjectSource[] | null) || [];
        const warnings = sources.length ? [] : ['project-sources-empty-or-unrecognized-dom'];
        return { ok: true, sources, warnings };
    } catch (err) {
        return { ok: false, sources: [], warnings: [(err as { message?: string })?.message || 'list-failed'] };
    }
}

/** Add files as project sources to a ChatGPT project. */
export async function addProjectSource(
    cdpSession: CdpSendSession | null,
    { projectUrl, filePaths, dryRun = false }: { projectUrl: string; filePaths: string[]; dryRun?: boolean },
): Promise<{ ok: boolean; uploads: ProjectUploadResult[]; warnings: string[]; errors: string[] }> {
    const urlCheck = validateProjectSourcesUrl(projectUrl);
    if (!urlCheck.ok) {
        return { ok: false, uploads: [], warnings: [], errors: [urlCheck.error || 'invalid-url'] };
    }

    const { valid, errors } = validateProjectSourceFiles(filePaths);
    if (!valid.length) {
        return { ok: false, uploads: [], warnings: [], errors: errors.length ? errors : ['no valid files'] };
    }

    if (dryRun) {
        return {
            ok: true,
            uploads: valid.map((f) => ({ name: f.name, type: 'file', uploaded: false })),
            warnings: ['dry-run-no-upload'],
            errors,
        };
    }
    if (!cdpSession) {
        return { ok: false, uploads: [], warnings: [], errors: ['CDP session required for project-sources add'] };
    }

    try {
        await cdpSession.send('Page.enable');
        await cdpSession.send('DOM.enable');
        await cdpSession.send('Page.navigate', { url: projectUrl });
        await new Promise((r) => setTimeout(r, 3000));

        const clickRes = (await cdpSession.send('Runtime.evaluate', {
            expression: `(() => {
                const selectors = ${JSON.stringify(ADD_SOURCE_SELECTORS)};
                for (const sel of selectors) {
                    const btn = document.querySelector(sel);
                    if (btn) { btn.click(); return 'clicked'; }
                }
                return 'not-found';
            })()`,
            returnByValue: true,
        })) as { result?: { value?: unknown } };

        if (clickRes?.result?.value !== 'clicked') {
            return { ok: false, uploads: [], warnings: ['add-source-button-not-found'], errors };
        }

        await new Promise((r) => setTimeout(r, 1000));

        const fileInputRes = (await cdpSession.send('Runtime.evaluate', {
            expression: `(() => {
                const input = document.querySelector('input[type="file"]');
                return input ? 'found' : 'not-found';
            })()`,
            returnByValue: true,
        })) as { result?: { value?: unknown } };

        if (fileInputRes?.result?.value !== 'found') {
            return { ok: false, uploads: [], warnings: ['file-input-not-found'], errors };
        }

        const doc = (await cdpSession.send('DOM.getDocument')) as { root?: { nodeId?: number } };
        const querySel = (await cdpSession.send('DOM.querySelector', {
            nodeId: doc.root?.nodeId,
            selector: 'input[type="file"]',
        })) as { nodeId?: number };

        await cdpSession.send('DOM.setFileInputFiles', {
            nodeId: querySel.nodeId,
            files: valid.map((f) => f.path),
        });

        await new Promise((r) => setTimeout(r, 3000));
        const evidence = (await evaluateJsonExpression(
            cdpSession,
            buildProjectSourcesUploadEvidenceExpression(valid.map((f) => f.name)),
        ).catch((err) => ({ ok: false, error: (err as { message?: string })?.message || String(err) }))) as { ok?: boolean } | null;
        const uploaded = evidence?.ok === true;

        return {
            ok: uploaded,
            uploads: valid.map((f) => ({ name: f.name, type: 'file', uploaded })),
            warnings: uploaded ? [] : ['upload-evidence-missing'],
            errors,
        };
    } catch (err) {
        return {
            ok: false,
            uploads: [],
            warnings: [(err as { message?: string })?.message || 'upload-failed'],
            errors,
        };
    }
}
