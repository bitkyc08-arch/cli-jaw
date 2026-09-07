import { constants as fsConstants } from 'node:fs';
import { access, lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertDocsOnlyEdit } from './policy.js';

export type JawCeoDocsEditPolicy = {
    allowedFiles: string[];
    allowedDirectories: string[];
};

export const JAW_CEO_MAX_PATCH_BYTES = 20 * 1024;
export const JAW_CEO_MAX_TARGET_BYTES = 1024 * 1024;

export function buildJawCeoDocsEditPolicy(args: {
    repoRoot: string;
    dashboardNotesRoot: string;
}): JawCeoDocsEditPolicy {
    return {
        allowedFiles: [
            path.join(args.repoRoot, 'README.md'),
        ],
        allowedDirectories: [
            path.join(args.repoRoot, 'docs'),
            args.dashboardNotesRoot,
        ],
    };
}

async function canonicalExistingOrParent(target: string): Promise<string> {
    try {
        return await realpath(target);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // A dangling symlink is not a missing file: writing through it could
        // escape the allowlist. Only genuinely absent components may be added.
        try {
            await lstat(target);
        } catch (statError) {
            if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
            const parent = path.dirname(target);
            if (parent === target) throw error;
            return path.join(await canonicalExistingOrParent(parent), path.basename(target));
        }
        throw error;
    }
}

async function canonicalizePolicy(policy: JawCeoDocsEditPolicy): Promise<JawCeoDocsEditPolicy> {
    const allowedFiles: string[] = [];
    for (const file of policy.allowedFiles) {
        allowedFiles.push(await canonicalExistingOrParent(path.resolve(file)));
    }
    const allowedDirectories: string[] = [];
    for (const directory of policy.allowedDirectories) {
        allowedDirectories.push(await canonicalExistingOrParent(path.resolve(directory)));
    }
    return { allowedFiles, allowedDirectories };
}

function isInside(root: string, target: string): boolean {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function hasHiddenSegmentOutsideNotes(target: string, notesRoot: string): boolean {
    if (isInside(notesRoot, target)) return false;
    return target.split(path.sep).some(segment => segment.startsWith('.') && segment.length > 1);
}

function assertUtf8Text(buffer: Buffer): void {
    if (buffer.includes(0)) {
        throw Object.assign(new Error('binary content is not eligible for CEO docs edit'), { code: 'docs_edit_binary_denied' });
    }
    const decoded = buffer.toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('utf8') !== decoded) {
        throw Object.assign(new Error('invalid UTF-8 content is not eligible for CEO docs edit'), { code: 'docs_edit_utf8_denied' });
    }
}

export async function resolveJawCeoDocsEditTarget(args: {
    targetPath: string;
    policy: JawCeoDocsEditPolicy;
}): Promise<{ canonicalPath: string; canonicalPolicy: JawCeoDocsEditPolicy }> {
    if (!path.isAbsolute(args.targetPath)) {
        throw Object.assign(new Error('docs edit path must be absolute'), { code: 'docs_edit_path_not_absolute' });
    }
    const canonicalPolicy = await canonicalizePolicy(args.policy);
    const canonicalPath = await canonicalExistingOrParent(args.targetPath);
    const allowedRoots = [...canonicalPolicy.allowedFiles, ...canonicalPolicy.allowedDirectories];
    const coarse = assertDocsOnlyEdit({ path: canonicalPath, allowedRoots });
    if (!coarse.ok) throw Object.assign(new Error(coarse.message), { code: coarse.code });
    const directFileAllowed = canonicalPolicy.allowedFiles.some(file => file === canonicalPath);
    const directoryAllowed = canonicalPolicy.allowedDirectories.some(directory => isInside(directory, canonicalPath));
    if (!directFileAllowed && !directoryAllowed) {
        throw Object.assign(new Error('path is outside the Jaw CEO docs-edit allowlist'), { code: 'docs_edit_root_denied' });
    }
    const notesRoot = canonicalPolicy.allowedDirectories[canonicalPolicy.allowedDirectories.length - 1] || '';
    if (hasHiddenSegmentOutsideNotes(canonicalPath, notesRoot)) {
        throw Object.assign(new Error('hidden paths are not eligible for CEO docs edit'), { code: 'docs_edit_hidden_path_denied' });
    }
    return { canonicalPath, canonicalPolicy };
}

function replaceMarkdownSection(current: string, content: string): string {
    const firstLine = content.split(/\r?\n/, 1)[0] || '';
    const heading = firstLine.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!heading) return `${current.replace(/\s*$/, '')}\n\n${content.trim()}\n`;
    const level = heading[1]!.length;
    const escapedTitle = firstLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const startMatch = current.match(new RegExp(`^${escapedTitle}\\s*$`, 'm'));
    if (!startMatch || startMatch.index === undefined) return `${current.replace(/\s*$/, '')}\n\n${content.trim()}\n`;
    const afterStart = startMatch.index + startMatch[0].length;
    const rest = current.slice(afterStart);
    const nextHeading = rest.match(new RegExp(`\\n#{1,${level}}\\s+`, 'm'));
    const endIndex = nextHeading?.index === undefined ? current.length : afterStart + nextHeading.index;
    return `${current.slice(0, startMatch.index)}${content.trim()}\n${current.slice(endIndex).replace(/^\n?/, '\n')}`;
}

export async function applyJawCeoDocsEdit(args: {
    targetPath: string;
    operation: 'append_section' | 'replace_section' | 'apply_patch';
    content: string;
    policy: JawCeoDocsEditPolicy;
}): Promise<{ path: string; bytes: number; operation: string }> {
    const contentBytes = Buffer.byteLength(args.content, 'utf8');
    if (contentBytes > JAW_CEO_MAX_PATCH_BYTES) {
        throw Object.assign(new Error('docs edit content exceeds 20 KB'), { code: 'docs_edit_patch_too_large' });
    }
    const { canonicalPath } = await resolveJawCeoDocsEditTarget({ targetPath: args.targetPath, policy: args.policy });
    let current = '';
    try {
        await access(canonicalPath, fsConstants.F_OK);
        const info = await stat(canonicalPath);
        if (info.size > JAW_CEO_MAX_TARGET_BYTES) {
            throw Object.assign(new Error('target file exceeds 1 MB'), { code: 'docs_edit_target_too_large' });
        }
        const buffer = await readFile(canonicalPath);
        assertUtf8Text(buffer);
        current = buffer.toString('utf8');
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code && code !== 'ENOENT') throw error;
    }
    let next: string;
    if (args.operation === 'append_section') {
        next = `${current.replace(/\s*$/, '')}\n\n${args.content.trim()}\n`;
    } else if (args.operation === 'replace_section') {
        next = replaceMarkdownSection(current, args.content);
    } else {
        next = args.content;
    }
    await mkdir(path.dirname(canonicalPath), { recursive: true });
    await writeFile(canonicalPath, next, 'utf8');
    return { path: canonicalPath, bytes: Buffer.byteLength(next, 'utf8'), operation: args.operation };
}
