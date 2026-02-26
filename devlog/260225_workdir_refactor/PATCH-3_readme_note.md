# PATCH-3: README Note Alignment (Docs Only)

**Files**: `README.md`, `README.ko.md`, `README.zh-CN.md`  
**Impact**: Documentation clarity only (no runtime effect)

---

## Why this patch

If default `workingDir` changes to `~/.cli-jaw`, AGENTS generation behavior changes for fresh installs.
README should state that AGENTS is generated under configured working directory (default `~/.cli-jaw`), while postinstall compatibility symlink (`~/CLAUDE.md` -> `~/AGENTS.md`) remains legacy/compat behavior.

---

## Proposed Diff (English README)

```diff
-> ⚠️ **Installation Notice:** ... custom instructions (`~/AGENTS.md` → `~/CLAUDE.md` symlink) ...
+> ⚠️ **Installation Notice:** ... custom instructions compatibility (`~/AGENTS.md` → `~/CLAUDE.md` symlink, if `~/AGENTS.md` exists) ...
+>
+> ℹ️ **Working Directory Default:** New installs default to `~/.cli-jaw` as working directory.
+> `AGENTS.md` is generated in `{workingDir}/AGENTS.md` (default: `~/.cli-jaw/AGENTS.md`).
```

## Proposed Diff (Korean README)

```diff
+> ℹ️ **기본 작업 디렉터리:** 신규 설치 기본값은 `~/.cli-jaw`입니다.
+> `AGENTS.md`는 `{workingDir}/AGENTS.md`에 생성됩니다 (기본: `~/.cli-jaw/AGENTS.md`).
```

## Proposed Diff (Chinese README)

```diff
+> ℹ️ **默认工作目录：** 新安装默认使用 `~/.cli-jaw`。
+> `AGENTS.md` 生成在 `{workingDir}/AGENTS.md`（默认：`~/.cli-jaw/AGENTS.md`）。
```

---

## Notes

- This patch should be applied in the same release as PATCH-1/2.
- If PATCH-1/2 are postponed, PATCH-3 should also be postponed to avoid doc/runtime mismatch.
