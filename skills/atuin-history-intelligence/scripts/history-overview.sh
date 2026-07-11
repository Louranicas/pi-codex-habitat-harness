#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C
db="${ATUIN_DB_PATH:-${XDG_DATA_HOME:-$HOME/.local/share}/atuin/history.db}"
capture_session_file="${ATUIN_CAPTURE_SESSION_FILE:-$HOME/.cache/claude-atuin-session}"
workspace="${CODEX_HABITAT_WORKSPACE:-$HOME/claude-code-workspace}"

command -v sqlite3 >/dev/null || { printf 'sqlite3 is required\n' >&2; exit 127; }
command -v jq >/dev/null || { printf 'jq is required\n' >&2; exit 127; }
[[ -r "$db" ]] || { printf 'Atuin database is not readable: %s\n' "$db" >&2; exit 1; }

query_json() {
  sqlite3 -readonly -json "$db" "$1"
}

shape="$(query_json "
  SELECT count(*) AS liveRows,
         count(DISTINCT command) AS distinctCommands,
         count(DISTINCT session) AS sessions,
         datetime(min(timestamp)/1000000000.0,'unixepoch') AS firstUtc,
         datetime(max(timestamp)/1000000000.0,'unixepoch') AS lastUtc,
         round((max(timestamp)-min(timestamp))/1000000000.0/86400.0,1) AS spanDays
  FROM history WHERE deleted_at IS NULL;")"

months="$(query_json "
  SELECT strftime('%Y-%m',datetime(timestamp/1000000000.0,'unixepoch')) AS month,
         count(*) AS historyRows,
         sum(lower(ltrim(command)) GLOB 'atuin *') AS atuinCalls,
         sum(lower(ltrim(command)) GLOB 'atuin kv *') AS kvCalls,
         sum(lower(ltrim(command)) GLOB 'atuin search*' OR lower(ltrim(command)) GLOB 'atuin history list*') AS historyQueries,
         sum(lower(ltrim(command)) GLOB 'atuin scripts run*') AS scriptRuns
  FROM history WHERE deleted_at IS NULL GROUP BY month ORDER BY month;")"

outcomes="$(query_json "
  SELECT CASE WHEN exit=0 THEN 'recorded_success' WHEN exit=-1 THEN 'unfinished_or_interactive' ELSE 'recorded_nonzero' END AS outcome,
         count(*) AS rows
  FROM history WHERE deleted_at IS NULL GROUP BY outcome ORDER BY rows DESC;")"

directories="$(query_json "
  SELECT cwd, count(*) AS rows
  FROM history WHERE deleted_at IS NULL GROUP BY cwd ORDER BY rows DESC LIMIT 20;")"

workflows="$(query_json "
  WITH h AS (SELECT lower(ltrim(command)) AS c FROM history WHERE deleted_at IS NULL),
  counts(label,rows) AS (
    SELECT 'read_filter_inspect',sum(c GLOB 'rg *' OR c GLOB 'grep *' OR c GLOB '/usr/bin/grep *' OR c GLOB 'head *' OR c GLOB 'tail *' OR c GLOB 'sed *' OR c GLOB 'find *') FROM h
    UNION ALL SELECT 'git',sum(c GLOB 'git *' OR c GLOB 'git-*') FROM h
    UNION ALL SELECT 'cargo_quality',sum(c GLOB 'cargo test*' OR c GLOB 'cargo check*' OR c GLOB 'cargo clippy*' OR c GLOB 'cargo fmt*' OR c GLOB 'cargo audit*' OR c GLOB 'cargo deny*') FROM h
    UNION ALL SELECT 'just',sum(c GLOB 'just *') FROM h
    UNION ALL SELECT 'npm_or_npx',sum(c GLOB 'npm *' OR c GLOB 'npx *') FROM h
    UNION ALL SELECT 'zellij',sum(c GLOB 'zellij *') FROM h
    UNION ALL SELECT 'curl',sum(c GLOB 'curl *') FROM h
    UNION ALL SELECT 'sqlite',sum(c GLOB 'sqlite3 *') FROM h
    UNION ALL SELECT 'loom',sum(c GLOB 'loom-*' OR c GLOB 'hb loom*' OR c GLOB 'bin/loom-*' OR c GLOB './bin/loom-*') FROM h
    UNION ALL SELECT 'codex_or_pi',sum(c GLOB 'codex *' OR c GLOB 'codex-harness*' OR c GLOB 'pi *') FROM h
  ) SELECT label,rows FROM counts ORDER BY rows DESC;")"

atuin_usage="$(query_json "
  WITH h AS (SELECT lower(ltrim(command)) AS c FROM history WHERE deleted_at IS NULL),
  counts(operation,rows) AS (
    SELECT 'kv_get',sum(c GLOB 'atuin kv get*') FROM h
    UNION ALL SELECT 'kv_set',sum(c GLOB 'atuin kv set*') FROM h
    UNION ALL SELECT 'kv_list',sum(c GLOB 'atuin kv list*') FROM h
    UNION ALL SELECT 'history_search',sum(c GLOB 'atuin search*' OR c GLOB 'atuin history list*') FROM h
    UNION ALL SELECT 'scripts_run',sum(c GLOB 'atuin scripts run*') FROM h
    UNION ALL SELECT 'stats',sum(c GLOB 'atuin stats*') FROM h
  ) SELECT operation,rows FROM counts ORDER BY rows DESC;")"

capture_rows=0
if [[ -r "$capture_session_file" ]]; then
  capture_session="$(tr -d '[:space:]' < "$capture_session_file")"
  if [[ "$capture_session" =~ ^[0-9a-fA-F-]{16,64}$ ]]; then
    capture_rows="$(sqlite3 -readonly "$db" "SELECT count(*) FROM history WHERE deleted_at IS NULL AND session='$capture_session';")"
  fi
fi

hook_present=false
[[ -r "$workspace/.claude/hooks/atuin-bash-capture.sh" ]] && hook_present=true

jq -n \
  --arg database "$db" \
  --arg home "$HOME" \
  --argjson shape "$shape" \
  --argjson months "$months" \
  --argjson outcomes "$outcomes" \
  --argjson directories "$directories" \
  --argjson workflows "$workflows" \
  --argjson atuinUsage "$atuin_usage" \
  --argjson captureRows "$capture_rows" \
  --argjson captureHookPresent "$hook_present" \
  'def redact_home:
     if . == $home then "~"
     elif startswith($home + "/") then "~" + .[($home | length):]
     else . end;
  {
    schema: "codex-harness.atuin-history-overview.v1",
    readOnly: true,
    commandBodiesEmitted: false,
    database: ($database | redact_home),
    shape: $shape[0],
    monthlyActivity: $months,
    recordedOutcomes: $outcomes,
    topDirectories: ($directories | map(.cwd |= redact_home)),
    workflowFamilies: $workflows,
    atuinUsage: $atuinUsage,
    provenance: {
      captureHookPresent: $captureHookPresent,
      currentCaptureSessionRows: $captureRows,
      exitCodeWarning: "The Habitat agent-capture hook records synthetic exit 0; do not use captured rows for success-rate claims."
    }
  }'
