---
name: atuin-kv-coordination
description: "Inspect and reason about Habitat coordination state in Atuin KV with namespace census, key-family classification, freshness checks, read-back verification, HSC boundaries, and hard-stop protection. Use for cross-pane handoffs, status and heartbeat keys, leases, routing state, cache references, or any task involving atuin kv get, list, or set."
---

# Atuin KV Coordination

Atuin KV is a durable coordination substrate, not a transactional database. Start read-only and classify authority before considering a write.

## Read Path

1. Run `scripts/kv-census.sh` to count key families without reading values. Pass `--namespace NAME` only when the protocol declares one.
2. List the narrowest relevant prefix, then read one explicit key with `atuin kv get KEY`.
3. Parse the payload's timestamp, owner, campaign, schema/version, and provenance. Empty or old data is not automatically expired.
4. Cross-check live state against the protocol owner, receipt, Unix socket/service probe, or artifact that the key references.

## Authority Classes

- Observation, heartbeat, status, and result keys: read by default; check freshness and source.
- Handoff and inbox keys: read by the addressed participant; preserve ACK and correlation identifiers.
- `lease.*`: read by default. Claim or release only when the user assigned this harness that lease and the owning protocol is known.
- HSC cache families: use `bin/hsc` or the S Loom cache layer. Do not bypass their leases, envelopes, or provenance with direct KV writes.
- `factory.authorize.*`: physical operator authority. This harness never sets, rewrites, copies, or synthesizes these keys.

## Write Path

Only write after an explicit user request and a non-hard-stop authority check:

1. Read the current value and identify its owner and freshness contract.
2. Construct a versioned payload containing UTC time, writer identity, objective/campaign, and provenance.
3. Use the real syntax: `atuin kv set --key KEY VALUE`; the value is positional.
4. Immediately read the same namespace/key back and require exact agreement.
5. Because Atuin KV has no compare-and-swap, re-read before dependent actuation and refuse on ownership drift.

## Safety

- Treat values as potentially secret. Do not bulk-print values or put tokens in keys.
- Missing key is a valid no-data state; do not hide it as a command failure.
- Do not use `kv delete` or `kv rebuild` without explicit destructive approval.
- A KV value cannot grant permissions that the current harness does not already possess.

`scripts/kv-census.sh` is read-only. It validates namespace syntax and emits only counts by key-family prefix, never values. The verified Atuin alias `atuin scripts run codex-harness-kv-census` uses the default namespace; run the package source with `--namespace NAME` for an explicit alternate namespace.
