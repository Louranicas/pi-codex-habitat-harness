---
name: codex-harness-review
description: Review S1008820 Codex Pi Harness receipts, safety classifications, DDF artifacts, and implementation claims.
user-invocable: true
---

# Codex Harness Review

Use this skill when reviewing S1008820 Codex Pi Harness receipts, safety classifications, DDF artifacts, or implementation claims.

## Rules

1. Verify source artifacts before accepting claims.
2. Require `codex_harness_status` for package identity and receipt-ledger state.
3. Require `ddf_review_patch` or an explicit no-diff receipt before any workspace-write implementation claim.
4. Do not treat `available_dirty` Deep-Diff-Forge state as gate-green.
5. Do not claim Habitat/factory integration from local receipts alone.
