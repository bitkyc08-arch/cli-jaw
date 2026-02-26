# 🖥️ Cross-Platform Compatibility — WSL / Linux / Windows

**Date**: 2025-02-25
**Severity**: High (blocks adoption on non-macOS)
**Status**: 📋 Planning

---

## Problem

All browser launch, CLI detection, and system-check logic assumes macOS.
On WSL, Linux VMs, or Windows native: browser skill dies, `doctor` skips half its checks,
`postinstall` can fail on symlinks and `which`, and `uv` install is Unix-only.

## Affected Files

| File | Lines | Issue |
|------|-------|-------|
| `bin/commands/serve.ts` | 82 | `open` command (macOS-only) |
| `src/browser/connection.ts` | 11-20 | Chrome paths hardcoded to `/Applications/` |
| `bin/commands/doctor.ts` | 101-143 | Accessibility + Chrome checks macOS-only |
| `src/core/config.ts` | 195-201 | `which` (no Windows `where` fallback) |
| `bin/postinstall.ts` | 44-50, 93-95, 191-220 | symlink, `which`, `curl \| sh` for uv |

## Fix Strategy

Split into 3 patches, ordered by impact:

1. **PATCH-1: Browser & Serve** — `connection.ts` + `serve.ts`
2. **PATCH-2: Doctor** — `doctor.ts` cross-platform checks
3. **PATCH-3: Postinstall & Config** — `postinstall.ts` + `config.ts`

Each patch is self-contained with its own diff plan document.
