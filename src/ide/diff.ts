/**
 * src/ide/diff.ts — IDE Diff View Module
 * Git diff 감지 + IDE (Antigravity/VS Code) 연동
 * 서버 변경 0줄 — jaw chat (TUI) 전용
 *
 * 접근법: before/after "dirty file set" 비교 (서브모듈 재귀 지원)
 */
import { execFileSync, execFile } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync, statSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';

// ─── Git ─────────────────────────────────────

/** cwd가 git repo 안인지 확인 */
export function isGitRepo(cwd: string): boolean {
    try {
        execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
            cwd, encoding: 'utf8', timeout: 3000, stdio: 'pipe',
        });
        return true;
    } catch { return false; }
}

/**
 * 현재 dirty 파일 세트 캡처 (서브모듈 재귀 포함)
 * 반환값: cwd 기준 상대경로 Map(path -> fingerprint)
 * fingerprint는 mtime/size/hash를 포함해 "같은 파일 재수정"도 안정적으로 감지한다.
 */
export function captureFileSet(cwd: string): Map<string, string> {
    const files = new Map<string, string>();
    try {
        // 1) parent repo: unstaged tracked changes
        const unstaged = git(cwd, ['diff', '--name-only']);
        // 2) parent repo: staged changes
        const staged = git(cwd, ['diff', '--name-only', '--cached']);
        // 3) parent repo: untracked files
        const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard']);

        const all = [...new Set([...unstaged, ...staged, ...untracked])];

        for (const entry of all) {
            const absPath = join(cwd, entry);
            try {
                const st = statSync(absPath);
                if (st.isFile()) {
                    files.set(entry, fileFingerprint(absPath, st.mtimeMs, st.size));
                } else if (st.isDirectory()) {
                    // 서브모듈: 내부 dirty 파일 재귀 탐색
                    const subFiles = captureFileSet(absPath);
                    for (const [sf, fp] of subFiles) files.set(join(entry, sf), fp);
                }
            } catch { /* 삭제됨 — 무시 */ }
        }
    } catch { /* non-git 등 */ }
    return files;
}

/** pre/post 세트 비교 → 에이전트가 변경한 파일만 반환 (fingerprint 변경 포함) */
export function diffFileSets(pre: Map<string, string>, post: Map<string, string>): string[] {
    return [...post.entries()]
        .filter(([f, fp]) => !pre.has(f) || pre.get(f) !== fp)
        .map(([f]) => f);
}

/** 파일 하나의 git diff stat을 해당 파일이 속한 repo에서 가져오기 */
function fileDiffStat(cwd: string, filePath: string): string {
    const absFile = join(cwd, filePath);
    try {
        if (!statSync(absFile).isFile()) return '';
    } catch { return ''; }

    // 파일이 속한 git repo의 root 찾기
    const fileDir = dirname(absFile);
    try {
        const repoRoot = realpathSync(execFileSync(
            'git', ['rev-parse', '--show-toplevel'],
            { cwd: fileDir, encoding: 'utf8', timeout: 3000, stdio: 'pipe' }
        ).trim());
        const realAbsFile = realpathSync(absFile);
        const relToRepo = relative(repoRoot, realAbsFile);
        return execFileSync(
            'git', ['diff', '--stat', '--color', 'HEAD', '--', relToRepo],
            { cwd: repoRoot, encoding: 'utf8', timeout: 5000, stdio: 'pipe' }
        ).trim();
    } catch { return ''; }
}

/** git diff --stat 요약 (서브모듈 파일 포함) */
export function getDiffStat(cwd: string, files: string[]): string {
    if (!files.length) return '';
    const lines: string[] = [];
    for (const file of files) {
        const stat = fileDiffStat(cwd, file);
        if (stat) lines.push(stat);
    }
    return lines.join('\n');
}

// ─── IDE 감지 ────────────────────────────────

export type IdeType = 'antigravity' | 'code' | null;

/** 현재 터미널이 실행 중인 IDE 감지 */
export function detectIde(): IdeType {
    // Antigravity: 여러 env 시그널 확인 (VS Code 포크라서 VSCODE_* 도 공존)
    if (process.env.ANTIGRAVITY_AGENT === '1') return 'antigravity';
    if (process.env.__CFBundleIdentifier?.includes('antigravity')) return 'antigravity';
    if (process.env.GIT_ASKPASS?.includes('Antigravity')) return 'antigravity';
    // VS Code
    if (process.env.TERM_PROGRAM === 'vscode' || process.env.VSCODE_PID) return 'code';
    return null;
}

/** IDE CLI 실행 명령어 반환 */
export function getIdeCli(ide: IdeType): string | null {
    if (!ide) return null;
    if (ide === 'antigravity') {
        return process.env.ANTIGRAVITY_CLI_ALIAS || 'antigravity';
    }
    return ide;  // 'code'
}

// ─── Diff 뷰 오픈 ───────────────────────────

/** IDE에서 좌우 diff 뷰 열기 */
export function openDiffInIde(
    cwd: string, files: string[], ide: IdeType, maxFiles = 5
): void {
    const cli = getIdeCli(ide);
    if (!cli) return;

    // .git 내부에 tmpdir 생성 (워크스페이스 전환 방지)
    const gitDir = join(cwd, '.git', 'jaw-diff');
    try { mkdirSync(gitDir, { recursive: true }); } catch { /* ignore */ }
    const tmpDir = mkdtempSync(join(gitDir, 'd-'));

    try {
        for (const file of files.slice(0, maxFiles)) {
            const absFile = join(cwd, file);
            try {
                if (!statSync(absFile).isFile()) continue;
            } catch { continue; }

            // 파일이 속한 git repo 찾기
            const fileDir = dirname(absFile);
            try {
                const repoRoot = execFileSync(
                    'git', ['rev-parse', '--show-toplevel'],
                    { cwd: fileDir, encoding: 'utf8', timeout: 3000, stdio: 'pipe' }
                ).trim();
                const relToRepo = relative(repoRoot, absFile);

                // 원본 (HEAD 상태) 추출
                const original = execFileSync(
                    'git', ['show', `HEAD:${relToRepo}`],
                    { cwd: repoRoot, encoding: 'utf8', timeout: 5000, stdio: 'pipe' }
                );
                const safeName = file.replace(/\//g, '__');
                const tmpFile = join(tmpDir, `${safeName}.orig`);
                writeFileSync(tmpFile, original);

                execFile(cli, ['-r', '--diff', tmpFile, absFile], (err) => {
                    if (err && process.env.DEBUG) console.warn(`[ide-diff] ${cli} --diff failed:`, err.message);
                });
            } catch {
                // 새 파일 (HEAD에 없음) → 그냥 열기
                execFile(cli, ['-r', '--goto', `${absFile}:1`], (err) => {
                    if (err && process.env.DEBUG) console.warn(`[ide-diff] ${cli} --goto failed:`, err.message);
                });
            }
        }
    } finally {
        setTimeout(() => {
            try { rmSync(tmpDir, { recursive: true, force: true }); } catch { }
        }, 10_000);
    }
}

// ─── Helper ──────────────────────────────────

function git(cwd: string, args: string[]): string[] {
    const out = execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
        cwd, encoding: 'utf8', timeout: 5000, stdio: 'pipe',
    }).trim();
    return out ? out.split('\n').filter(Boolean) : [];
}

/**
 * 파일 fingerprint 생성.
 * - 기본: mtime + size
 * - 텍스트 위주 dirty file은 내용 hash(sha1)까지 포함해 재수정 누락 방지
 */
function fileFingerprint(absPath: string, mtimeMs: number, size: number): string {
    // 너무 큰 파일 해시는 비용이 커서 mtime/size만 사용
    if (size > 2 * 1024 * 1024) return `${mtimeMs}:${size}`;
    try {
        const hash = createHash('sha1').update(readFileSync(absPath)).digest('hex');
        return `${mtimeMs}:${size}:${hash}`;
    } catch {
        return `${mtimeMs}:${size}`;
    }
}
