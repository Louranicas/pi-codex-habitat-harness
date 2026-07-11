# pi-codex-habitat-harness

S1008820 terminal-first Pi package for `openai-codex/gpt-5.6-sol`, Zod, the Codex SDK, and the Zellij Habitat factory.

Status: read-write capacity slice — gates 08/14/18/19/20 are promoted when their live evidence probes pass, and package-scoped confirmed writes are enabled with receipt-backed read-back verification. Deploy/push/ship/factory arming remain blocked.

Implemented:

- PackageIdentity check for canonical root `pi-codex-habitat-harness/` and forbidden alternate root `.pi-codex-habitat-harness/`.
- RunEnvelope v2 Zod contract matching `config/codex-pi-harness-receipt.schema.json`.
- Local receipt ledger with redaction, read-back verification, and hash-chain validation under `.pi/codex-harness/receipts/`.
- Productivity-tuned safety classifier for AUTO / DEFER / GATE / BLOCK: normal package/tooling work is allowed/deferred, while catastrophic deletion/system damage, `.git` mutation, factory authorization, DDF daemon start, and Fabric server hard-stops remain blocked.
- Deep-Diff-Forge one-shot `review` / `rank` / `cluster` wrapper, malformed-patch typed failure, and patch-truth preservation flag.
- Habitat capacity probes for receipt circulation (GATE-08), Zellij plugin inventory/pipe ACK contract (GATE-14), runbook FSM registry (GATE-18), Fabric dry-run/readpattern bridge (GATE-19), and DDF fixture proof (GATE-20).
- Package-scoped confirmed write tool with blocked `.git`/`node_modules`/`dist`/lockfile targets, read-back SHA verification, and receipt emission.
- Arena capacity runner (`npm run arena -- ..`) that exercises the full read/write feature set and writes a report under `.pi/codex-harness/arena/`.
- `codex-harness` launcher that runs selftest + arena + capacity status, verifies hard stops, prompts for `OPENAI_API_KEY` in an interactive terminal when missing, then launches Pi through project-package discovery so built-in reload remains available.
- Project-local `.pi/settings.json` pins Pi to `gpt-5.6-sol` with its highest exposed thinking level (`xhigh`).
- Pi extension entrypoint with `/codex-harness-status` plus harness tools.
- First-class Codex/Zod/Agents tools: `codex_feature_inventory`, `zod_validate_json`, guarded live `codex_sdk_run`, and guarded live `openai_agents_ts_run`.
- Pi runs SOL 5.6 at its highest exposed level (`xhigh`); `codex_sdk_run` independently defaults to SOL `max` reasoning, confirmation-gated `workspace-write`, optional confirmed network, and Zod-backed `sol56_task_result` output.
- Native Pi `bash`, `write`, and `edit` tools remain the primary execution plane; an extension hook blocks armed/catastrophic shell transitions, missing targets, lexical escapes, symlink escapes, and `.git` writes without disabling normal edits, builds, installs, or tests.
- First-class Habitat tools cover Just recipe discovery and safe execution, source-indexed runbook search/read, WIP GATE-RB preview validation, provenance-hashed Fabric transforms, and live service probes.
- Loom tools expose the unchanged Habitat operational roster, native `hb loom` planning, and the separate harness-owned S Loom Roster. `codex_s_loom_roster` inspects modules; `codex_s_lobe_plan` composes a non-dispatching plan; `codex_loom_cluster` runs a standalone module or a 3-5 module lobe.
- The S Loom Roster contains `review`, `build`, `debug`, `architecture`, `innovation`, `harness`, and the final specialized `observe` module. `observe` correlates logs, SLOs, benchmark validity, and deployment-readiness evidence, but cannot actuate a deployment.
- Each S Loom role has an HSC smart-cache namespace partitioned by module, role, persona genome, Git-root workspace state, and objective. Only exact outside-judge `proceed` seals with a live hash-verified admission artifact are admitted; revise/collapse results, timeouts, traps, external/untracked symlinks, dirty gitlinks, incomplete workspace hashes, stale genomes, and unclassified lane digests cannot be reused.
- Persona hot swaps resolve through `loom-dependencies/personas/PERSONA_MANIFEST.json`, remain fixed read-only, reject permission widening and null-force substitutions, and use profile-qualified keys such as `review.failure-adversary` in stacked lobes.
- S lobes apply D0 collapse for small work, 3-5 read-only meso lanes when coordination is earned, an outside-context same-family macro judge, at most one confirmed writer, and a verifier. Their topology uses nested-torus containment, Hopf lane separation, gyroid seal exchange, and geodesic proof closure. In-process calls and bounded stdio are preferred; a versioned Unix socket is reserved for an actual long-lived endpoint.
- The macro judge receives only a compact canonical seal envelope. Its streamed SOL turn aborts immediately on terminal, file, web, MCP, or todo activity; a 480-second total budget reserves at most 240 seconds for the high-reasoning primary and the remainder for one medium-reasoning structured retry. Exact digest classification still gates every cache admission.
- The wider Habitat operational loom roster remains authoritative and includes the persona manifest, root Justfile, `bin/loom-*`, `hb loom`, workflow looms, and Loom Kernel contracts. `loom-lattice-habitat` remains WIP/deployment-phase evidence only and is not an operational dependency.
- Harness-specific Atuin skills cover privacy-safe history intelligence, KV coordination, and script curation. Their package-local helpers emit aggregate JSON, never bulk-read KV values, never execute registered scripts, and require explicit confirmation before registration or writes.
- Browser automation uses the official Playwright agent CLI directly in the terminal, with isolated desktop/mobile sessions, accessibility snapshots, screenshot/console/network/trace evidence, workspace-confined artifacts, and hash-chained evidence sealing. It does not require a browser MCP.
- Project package loading supports Pi's built-in `/reload` for extensions, skills, prompts, themes, and context files.

Local checks:

```bash
codex-harness                       # validate, then launch SOL 5.6 Pi from project package settings
codex-harness --check-only          # full validation without launching Pi
npm run observe-proof -- --confirm-live  # live four-lane observe loom + judge, 480s per call
npm run observe-judge-replay -- --confirm-live --artifact .pi/codex-harness/loom-clusters/<artifact>.json
# inside Pi after changing package resources:
/reload
/codex-harness-status
# inspect or invoke the package skill after reload:
/skill:sol56-terminal-loom
/skill:atuin-history-intelligence
/skill:atuin-kv-coordination
/skill:atuin-script-curation
/skill:browser-operations
```

Browser work is terminal-first through the locally pinned Playwright agent CLI; no browser MCP is required:

```bash
playwright-cli -s=ui-check open http://127.0.0.1:3000
playwright-cli -s=ui-check snapshot
playwright-cli -s=ui-check screenshot
playwright-cli -s=ui-check-mobile open http://127.0.0.1:3000 --mobile
```

The harness defaults to isolated headless Chrome, a 1440x900 desktop viewport, blocked service workers, no downloads, and workspace evidence under `.pi/codex-harness/browser`. Use `codex_browser_inventory` before browser work and `codex_browser_evidence_seal` afterward. Attaching authenticated browser state or changing remote state requires explicit user confirmation.

Read-only Atuin helper proofs:

```bash
pi-codex-habitat-harness/skills/atuin-history-intelligence/scripts/history-overview.sh
pi-codex-habitat-harness/skills/atuin-kv-coordination/scripts/kv-census.sh
pi-codex-habitat-harness/skills/atuin-script-curation/scripts/script-registry-audit.sh
```

The same reviewed bodies are registered in Atuin and were hash/read-back verified:

```bash
atuin scripts run codex-harness-history-overview
atuin scripts run codex-harness-kv-census
atuin scripts run codex-harness-script-audit
```

Compatibility alias: `start-codex-harness`.

Do not run deploy, ship, push, DDF daemon start, DDF learn record, Fabric server, runbook execution, or factory dispatch without a separate explicit arming instruction.
