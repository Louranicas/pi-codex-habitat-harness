#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C
namespace="default"

while (($#)); do
  case "$1" in
    --namespace)
      (($# >= 2)) || { printf '%s\n' '--namespace requires a value' >&2; exit 2; }
      namespace="$2"
      shift 2
      ;;
    -h|--help)
      printf 'usage: %s [--namespace NAME]\n' "${0##*/}"
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

[[ "$namespace" =~ ^[A-Za-z0-9._-]+$ ]] || { printf 'invalid namespace: %s\n' "$namespace" >&2; exit 2; }
command -v atuin >/dev/null || { printf 'atuin is required\n' >&2; exit 127; }
command -v jq >/dev/null || { printf 'jq is required\n' >&2; exit 127; }

keys="$(atuin kv list --namespace "$namespace")"
key_count="$(printf '%s\n' "$keys" | awk 'NF {n++} END {print n+0}')"
families="$(
  printf '%s\n' "$keys" \
    | awk -F. 'NF {count[$1]++} END {for (family in count) printf "%d\t%s\n", count[family], family}' \
    | sort -k1,1nr -k2,2 \
    | head -n 40 \
    | jq -R -s 'split("\n") | map(select(length > 0) | split("\t") | {rows: (.[0] | tonumber), family: .[1]})'
)"

jq -n \
  --arg namespace "$namespace" \
  --argjson keyCount "$key_count" \
  --argjson families "$families" \
  '{
    schema: "codex-harness.atuin-kv-census.v1",
    readOnly: true,
    valuesRead: false,
    namespace: $namespace,
    keyCount: $keyCount,
    topKeyFamilies: $families,
    warnings: [
      "Key presence does not prove freshness; inspect timestamps and protocol ownership before use.",
      "Atuin KV has no compare-and-swap; a read-back is required after any separately authorized write."
    ]
  }'
