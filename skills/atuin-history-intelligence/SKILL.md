---
name: atuin-history-intelligence
description: "Analyze Atuin shell history for the Codex Harness with privacy-safe aggregates, workspace and time scoping, workflow-frequency evidence, session provenance, and failure caveats. Use when asked what commands or workflows are common, what changed over time, which directories are active, whether a workflow is adopted, or what prior terminal activity can inform current work."
---

# Atuin History Intelligence

Use Atuin as longitudinal terminal evidence, not as unquestioned truth. Default to aggregate output; reveal command bodies only when the user explicitly asks to recall a specific command.

## Workflow

1. Run `scripts/history-overview.sh` for the current shape, monthly growth, active directories, workflow families, Atuin usage, and capture provenance.
2. Narrow with Atuin's own filters: `--after`, `--before`, `--cwd`, `--exit`, and `--filter-mode workspace`.
3. Report counts, trends, directories, and command families. Redact credentials, tokens, query strings, payloads, and environment assignments.
4. Cross-check a claimed workflow against its source, Just recipe, receipt, or test. History proves invocation, not correctness or intent.

## Provenance Rules

- The Habitat PostToolUse hook records agent shell commands under a long-lived Atuin session, flattens newlines, truncates at 1,500 characters, and records exit `0` even when the underlying command failed.
- Treat exit-code analysis for that capture session as invalid. Separate captured-agent rows from interactive shell rows before discussing success rates.
- Atuin rows can be duplicated, imported, deleted, or synced. State the time window and filter mode with every quantitative claim.
- A high command count can indicate retries, generated probes, or automation, not user preference.

## Query Selection

- Aggregate inventory: run `scripts/history-overview.sh`.
- Exact prior command: `atuin search --cmd-only --limit 20 --filter-mode workspace '<query>'`, then redact before reporting.
- Time-bounded recall: add `--after '<date>' --before '<date>'`.
- CWD-bounded recall: add `--cwd '<absolute-path>'`.
- Failed interactive work: use `--exclude-exit 0` only after excluding or qualifying the synthetic capture session.
- Multiline-safe processing: use `--print0`; never parse command bodies line-by-line by default.

## Safety

- Never use `atuin search --delete`, `--delete-it-all`, history deletion, import, sync, account, key, daemon, or server commands without a separate explicit request.
- Never print the Atuin encryption key, session token, raw environment exports, or unredacted command payloads.
- Open SQLite read-only. Do not rebuild, vacuum, migrate, or mutate the database as part of analysis.

`scripts/history-overview.sh` is read-only and emits JSON without command bodies. It honors `ATUIN_DB_PATH` when a non-default database is intentionally selected. The verified Atuin alias is `atuin scripts run codex-harness-history-overview`.
