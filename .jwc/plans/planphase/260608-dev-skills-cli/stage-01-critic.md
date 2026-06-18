# 140.1 — P-Stage Critic Review (Round 1)

**Reviewed**: 140_pabcd_p_plan.md
**Against**: .jwc/specs/jaw-interview-dev-skill-expansion.md, 130_audit_decisions.md, 131–134 patch plans
**Date**: 2026-06-16

## Verdict: ITERATE

The plan correctly inventories ~26 new ref files + dev-devops across four waves and aligns with the spec topology and 115 MOC wave ordering at a high level. It is not ready for B-stage execution: wave-per-merge creates broken cross-references, CI steps are unspecified, registry/active registration is incomplete, and the 126 quality gate is stated but not operationally enforceable.

---

## Findings

### 1. CRITICAL — Wave 1 SKILL.md rows reference files that do not exist until Wave 4

**What is wrong**: The spec requires wave-per-merge (Wave별 단계 머지). Wave 1 MODIFY steps add Modular References rows for files created later:

| Wave 1 MODIFY | Row added | File created |
|---------------|-----------|--------------|
| dev-code-reviewer/SKILL.md (#8) | ai-assisted-review.md | Wave 4 (#32) |
| dev-scaffolding/SKILL.md (#9) | monorepo-tooling.md | Wave 4 (#36) |

After Wave 1 merges, agents following Modular References hit dead links.

**What to fix**: Either (a) move those table rows to Wave 4 with their files, (b) split Wave 1 table updates so each row lands in the same wave as its ref, or (c) add explicit stub-until-Wave-N policy with placeholder refs (not recommended per 126).

---

### 2. CRITICAL — Wave 3 cross-ref depends on Wave 4 security ref

**What is wrong**: 132_patch_ml.md requires llm-integration.md §6 to cross-reference dev-security/references/llm-supply-chain.md. The plan places llm-integration.md in Wave 3 (#21) and llm-supply-chain.md in Wave 4 (#34). Per-wave merge breaks the cross-ref at Wave 3.

**What to fix**: Move llm-supply-chain.md (and its dev-security/SKILL.md row) to Wave 3, or defer the llm-integration.md §6 cross-ref to a Wave 4 follow-up step explicitly listed in the plan.

---

### 3. CRITICAL — CI acceptance criterion has no concrete steps; adding dev-devops will fail existing gates

**What is wrong**: Spec acceptance includes CI 통과. The plan only lists per-wave file-existence checks. skills_ref/.github/workflows/ci.yml runs scripts/validate_public_surface.py, which hard-codes EXPECTED_SKILLS = 225 and README/docs surface counts (225, 44 skills, etc.). Adding dev-devops/SKILL.md yields 226 skills and fails CI without coordinated updates.

**What to fix**: Add a Wave 2 (or final) step listing exact files/commands:

- skills_ref/scripts/validate_public_surface.py — bump EXPECTED_SKILLS to 226
- skills_ref/README.md — update skill-count badges
- skills_ref/docs/index.html — update public-surface counts if validated
- Run: python3 -m pytest tests/test_dev_frontend_refresh.py -q and python3 scripts/validate_public_surface.py

---

### 4. MAJOR — release_cd task_tags update missing from Wave 1

**What is wrong**: 131_patch_devops.md and 130_audit_decisions.md (U-6) require updating the existing release_cd row to include dev-devops. Wave 1 step #10 only adds three new tag rows and does not patch release_cd.

**What to fix**: Add explicit MODIFY to skills_ref/dev/SKILL.md §0.3 for release_cd to include dev-devops. Place in Wave 1 or Wave 2; document which.

---

### 5. MAJOR — registry.json entry is incomplete; active 등록 mechanism undocumented

**What is wrong**: Wave 2 step #19 shows only name, category, emoji. Existing dev entries require name_ko, name_en, description, desc_ko, desc_en, version, etc. Spec requires registry.json + active 등록; the plan mentions only registry with no procedure.

**What to fix**: Provide a full registry template keyed dev-devops mirroring dev-pabcd/dev-backend. Document that category orchestration triggers auto-activation via lib/mcp/skills-distribution.ts (OPENCLAW_ACTIVE from registry).

---

### 6. MAJOR — 126 quality gate is not enforceable as written

**What is wrong**: The plan copies 126 headline rules but omits mandatory metadata (§4.1), measurement method (§5.1), Refs Self-Audit (§4.5), PR checklist (§9), and type-specific minimums (§5.2). Verification says 품질 게이트 체크리스트 통과 without defining who runs what or what fails the wave.

**What to fix**: Add per-wave gate step: Run 126 §9 PR checklist on every new/changed ref; attach ratio + Self-Audit answers in devlog evidence.

---

### 7. MAJOR — Spec constraint SKILL.md 핵심 코드 예시 (dev-backend 패턴) not carried into Wave 2

**What is wrong**: Spec requires core code examples in dev-devops SKILL.md following dev-backend (inline banned/fix tables, fenced snippets). Wave 2 lists section titles only.

**What to fix**: Add acceptance bullets: minimum 2 fenced examples plus ≥1 anti-pattern table matching dev-backend density.

---

### 8. MAJOR — dev-ml separation checkpoint from 132 omitted

**What is wrong**: 132_patch_ml.md requires a one-time checkpoint after ML refs land. 140_pabcd_p_plan.md has no checkpoint step.

**What to fix**: Add post-Wave 3 verification: count ML refs lines/files; record go/no-go for dev-ml spoke in devlog.

---

### 9. MAJOR — dev-data/SKILL.md ml-pipeline linkage ambiguous

**What is wrong**: Wave 3 step #28 says inline ref로 ml-pipeline.md 참조 추가. dev-data/SKILL.md uses inline See references/tools.md pattern without a Modular References table. Implementer must guess section and wording.

**What to fix**: Specify exact insertion point (e.g. after §6 Tool Decision Matrix) and canonical line pattern: See references/ml-pipeline.md for ML training/feature-store patterns.

---

### 10. MINOR — Forward cross-ref from Wave 1 observability expand to Wave 2 SRE ref

**What is wrong**: observability.md cross-ref to dev-devops/references/sre-foundations.md in Wave 1, but sre-foundations.md is Wave 2 (#16).

**What to fix**: Move observability cross-ref addition to Wave 2.

---

### 11. MINOR — Parallel subagent execution not operationalized

**What is wrong**: Spec requires 서브에이전트 병렬 실행. Plan lists waves but not which files within a wave are independent.

**What to fix**: Add a parallelization matrix per wave (e.g. Wave 3: ML refs #20–23 parallel with mobile refs #24–26).

---

### 12. MINOR — Valid audit debt from 130 not scoped

**What is wrong**: 130 lists broken edge-first-testing anchor, cli-jaw orchestrate I residue, dev 491-line cap. Plan does not address or defer them.

**What to fix**: Add Out of scope note or Wave 0 cleanup.

---

## Evaluation Criteria Summary

| Criterion | Assessment |
|-----------|------------|
| 1. Acceptance criteria covered | Partial — file inventory good; CI, active registration, full task_tags, 126 enforcement gaps |
| 2. File paths concrete | Good — consistent skills_ref/ paths; registry template incomplete |
| 3. Scope holes | Yes — CI scripts, release_cd tag, dev-ml checkpoint, 130 debt |
| 4. Ambiguous steps | Yes — dev-data inline ref, active 등록, quality gate verification |
| 5. Wave ordering | Mostly correct — broken forward refs violate wave-per-merge |
| 6. Quality gate (126) enforceable | No — criteria quoted but no measurement, checklist, or evidence hook |

---

## Recommended next revision

1. Reconcile all Modular References / cross-ref edits with the wave that creates the target file.
2. Add CI + registry full-template + active-registration steps.
3. Wire 126 §9 as mandatory per-wave verification with evidence path.
4. Add dev-ml checkpoint and parallelization matrix.
5. Re-submit for critic round 2.
