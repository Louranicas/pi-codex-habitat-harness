---
name: sol56-terminal-loom
description: Operate and validate the Codex Harness as a terminal-first gpt-5.6-sol environment with workspace-write tools, Zod contracts, Playwright browser automation, the modular S Loom Roster, Habitat looms, Justfiles, runbooks, Fabric, persona hot swaps, and HSC smart-cache memory. Use for substantial coding, review, debugging, browser verification, architecture, observability, benchmarking, or distributed-cognition work launched through codex-harness.
---

# SOL 5.6 Terminal Loom

Use this skill for substantial coding, review, debugging, architecture, or distributed-cognition work inside the Codex Harness.

## Runtime

- Prefer native Pi `bash`, `read`, `edit`, and `write` tools for direct work.
- Use `codex_sdk_run` for a nested SOL 5.6 turn. Workspace write requires `confirmWorkspaceWrite=true`; network requires `confirmNetworkAccess=true`.
- Use `outputSchemaName=sol56_task_result` when the result must be Zod-validated.
- Use the `browser-operations` skill and local `playwright-cli` for browser work. Capture desktop and mobile snapshot/screenshot evidence, then seal it with `codex_browser_evidence_seal`.
- MCP is optional integration plumbing, not the execution plane.

## Loom Selection

1. Apply the D0 gate: use direct execution for a small, single-surface task.
2. Call `habitat_loom_inventory` before selecting a loom body.
3. Use `habitat_loom_plan` for native `hb loom` geometry and tool-resolution plans.
4. Use `codex_s_loom_roster` to inspect the separate S roster and `codex_s_lobe_plan` to validate a proposed 3-5 module stack without dispatch.
5. Use `codex_loom_cluster` only when independent lenses, decomposition, or an outside judge earns the coordination cost. Select from `review`, `build`, `debug`, `architecture`, `innovation`, `harness`, and `observe`.
6. Use `observe` for log forensics, SLO analysis, benchmark comparison, and deployment-readiness evidence. A readiness seal never grants deployment authority.
7. Parallel lanes are read-only. At most one writer receives confirmed workspace-write after the judge barrier.
8. The SOL judge is outside worker contexts but same-model-family; never claim cross-family independence.

## S Lobe Contract

- Micro: each role runs its own evidence loop and emits a bounded typed seal.
- Meso: 3-5 Hopf-separated modules exchange seals and HSC references through a gyroid shared medium, never mutable state.
- Macro: an outside-context judge classifies every lane digest exactly once; `proceed` needs at least two accepted lane digests before any writer can run.
- Judge boundary: send only the canonical compact lane-seal envelope. The streamed judge must abort on terminal, file, web, MCP, or todo activity; use a high-reasoning primary capped at 120 seconds and one medium retry inside the same 240-second total budget.
- Transport: stay in-process under one owner; use bounded stdio for one-shot SDK workers; use a versioned Unix socket only when a real long-lived local endpoint exists.
- Memory: cache identity binds profile, role, persona genome, roster/module hashes, Git-root workspace state, and objective. Only judged `proceed` seals with a hash-verified in-workspace admission artifact are reusable; dirty gitlinks or unsafe symlinks disable reuse.
- Persona swaps: use a bare role key only for a standalone module. In stacks use `<profile>.<role>`, for example `review.failure-adversary`. Refuse unregistered personas, permission widening, and behaviorally null swaps.

## Operational Roster

Treat these as operational source-of-truth surfaces:

- `loom-dependencies/personas/PERSONA_MANIFEST.json`
- root `justfile`
- `bin/loom-template`, `bin/loom-contract`, `bin/loom-dispatch`, and `bin/hopf-anchor`
- `hb loom`
- `.claude/workflows/*loom*.js`
- Loom Kernel contracts and proof policy

`loom-lattice-habitat` is WIP/deployment-phase. Its results are preview or drift evidence, never operational authority.

## Just, Runbooks, Fabric

- Discover Just recipes from `just --dump --dump-format json`.
- Run only operational `observe`, `quality`, or `ops` recipes through `habitat_just_run`; unknown, mutating, and armed recipes fail closed.
- Search/read prose runbooks as authority maps. Do not execute prose as code.
- `habitat_runbook_validate` is a WIP GATE-RB preview, not a live actuation grant.
- Fabric is advisory, absence-tolerant, and non-gating. Preserve pattern/input/output hashes when using `habitat_fabric_transform`.

## Reload And Proof

- Launch from the shell with `codex-harness`.
- After changing an extension, skill, prompt, theme, or context file, run Pi's built-in `/reload`.
- Re-run `codex_harness_status` and `codex_feature_inventory` after reload.
- Verify code changes with focused tests, then the harness arena and DDF patch review.

## Hard Stops

No deploy, push, ship, publish, tag, service restart, factory authorization write, daemon/server start, `.git` mutation, danger-full-access route, browser `--no-sandbox`, or unrestricted browser file access.
