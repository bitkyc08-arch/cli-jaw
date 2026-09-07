/**
 * lib/media-kind.ts — 미디어 종류 판정 단일 소스
 *
 * 확장자 → image/video/file 판정이 프롬프트 생성 지점마다 재구현되어 있었고,
 * 그 결과 서버 다중 첨부(2개 이상)와 웹 첨부(개수 무관)가 파일 종류를 잃었다.
 *
 *
 * 이 파일은 두 tsconfig가 각각 타입체크한다:
 *   tsconfig.json          (NodeNext)  — include: lib/**\/*.ts
 *   tsconfig.frontend.json (bundler)   — public/js import 그래프로 전이 검사
 * 따라서 의존성이 없어야 하고 Node/DOM 전역을 참조하면 안 된다.
 * `node:path` 의 extname 을 쓰지 않는 이유가 이것이다.
 */

export type MediaKind = 'image' | 'video' | 'file';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.ogg']);

/** 경로/파일명의 확장자로 미디어 종류를 판정한다. 순수 함수. */
export function mediaKindFromPath(filePath: string): MediaKind {
    const leaf = String(filePath || '').split(/[\\/]/).pop() || '';
    const dot = leaf.lastIndexOf('.');
    // dot > 0: 점으로 시작하는 이름(.gitignore)은 확장자가 아니다.
    const ext = dot > 0 ? leaf.slice(dot).toLowerCase() : '';
    if (IMAGE_EXTS.has(ext)) return 'image';
    if (VIDEO_EXTS.has(ext)) return 'video';
    return 'file';
}
