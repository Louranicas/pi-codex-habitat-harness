Review the supplied patch through the S1008820 harness path:

1. Classify permissions with `codex_permission_classify`.
2. Run `ddf_review_patch` in `review`, `rank`, and `cluster` modes when a patch is present.
3. Report schema names, risk summary, receipt hash, and whether patch truth was preserved.
4. If no patch is present, write an explicit local no-diff receipt instead of claiming implementation.
