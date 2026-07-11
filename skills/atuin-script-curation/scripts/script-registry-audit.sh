#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C
db="${ATUIN_DB_PATH:-${XDG_DATA_HOME:-$HOME/.local/share}/atuin/history.db}"

command -v atuin >/dev/null || { printf 'atuin is required\n' >&2; exit 127; }
command -v sqlite3 >/dev/null || { printf 'sqlite3 is required\n' >&2; exit 127; }
command -v jq >/dev/null || { printf 'jq is required\n' >&2; exit 127; }
[[ -r "$db" ]] || { printf 'Atuin database is not readable: %s\n' "$db" >&2; exit 1; }

catalog="$(atuin scripts list)"
names="$(printf '%s\n' "$catalog" | sed -n 's/^- \([^ ]*\).*/\1/p')"
registered_total="$(printf '%s\n' "$names" | awk 'NF {n++} END {print n+0}')"

runs="$(sqlite3 -readonly -separator $'\t' "$db" "
  WITH h AS (
    SELECT lower(ltrim(command)) AS c
    FROM history
    WHERE deleted_at IS NULL AND lower(ltrim(command)) GLOB 'atuin scripts run *'
  ), names AS (
    SELECT substr(substr(c,19),1,instr(substr(c,19)||' ',' ')-1) AS script FROM h
  )
  SELECT script,count(*) FROM names GROUP BY script ORDER BY count(*) DESC,script;")"

recorded_direct_runs="$(printf '%s\n' "$runs" | awk -F '\t' 'NF >= 2 {sum += $2} END {print sum+0}')"
used_script_count="$(
  comm -12 \
    <(printf '%s\n' "$names" | awk 'NF' | sort -u) \
    <(printf '%s\n' "$runs" | awk -F '\t' 'NF >= 2 {print $1}' | sort -u) \
    | awk 'NF {n++} END {print n+0}'
)"
never_recorded="$((registered_total - used_script_count))"
((never_recorded < 0)) && never_recorded=0

top_runs="$(printf '%s\n' "$runs" | head -n 20 | jq -R -s '
  split("\n") | map(select(length > 0) | split("\t") | {script: .[0], recordedDirectRuns: (.[1] | tonumber)})')"

risk_names="$(printf '%s\n' "$names" | grep -Ei '(deploy|restart|dispatch|cascade|scale|register|import|retire|delete|format|wake|sentry|autopilot|full-cycle|start)' || true)"
risk_candidates="$(printf '%s\n' "$risk_names" | jq -R -s 'split("\n") | map(select(length > 0))')"

top_tags="$(
  printf '%s\n' "$catalog" \
    | sed -n 's/.*\[tags: \([^]]*\)\].*/\1/p' \
    | tr ',' '\n' \
    | awk '{$1=$1} NF {count[$0]++} END {for (tag in count) printf "%d\t%s\n", count[tag], tag}' \
    | sort -k1,1nr -k2,2 \
    | head -n 30 \
    | jq -R -s 'split("\n") | map(select(length > 0) | split("\t") | {scripts: (.[0] | tonumber), tag: .[1]})'
)"

jq -n \
  --argjson registeredTotal "$registered_total" \
  --argjson recordedDirectRuns "$recorded_direct_runs" \
  --argjson usedScriptCount "$used_script_count" \
  --argjson neverRecorded "$never_recorded" \
  --argjson topRuns "$top_runs" \
  --argjson riskCandidates "$risk_candidates" \
  --argjson topTags "$top_tags" \
  '{
    schema: "codex-harness.atuin-script-registry-audit.v1",
    readOnly: true,
    bodiesRead: false,
    scriptsExecuted: false,
    registeredTotal: $registeredTotal,
    recordedDirectRuns: $recordedDirectRuns,
    scriptsWithRecordedDirectRuns: $usedScriptCount,
    registeredWithoutRecordedDirectRun: $neverRecorded,
    topRecordedRuns: $topRuns,
    topTags: $topTags,
    riskNameCandidates: $riskCandidates,
    warnings: [
      "Recorded direct runs exclude cron, wrappers, imported history, and unrecorded shells.",
      "Risk names are metadata triage only; inspect the full script body before execution."
    ]
  }'
