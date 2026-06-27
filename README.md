# pi-codex-habitat-harness

S1008820 Codex-optimized Pi package for the Zellij Habitat factory.

Status: first coding slice only — offline judge spine. Deploy/push/ship/factory arming remain blocked.

Implemented in this slice:

- PackageIdentity check for canonical root `pi-codex-habitat-harness/` and forbidden alternate root `.pi-codex-habitat-harness/`.
- RunEnvelope v2 Zod contract matching `config/codex-pi-harness-receipt.schema.json`.
- Local receipt ledger with redaction, read-back verification, and hash-chain validation under `.pi/codex-harness/receipts/`.
- Safety classifier for AUTO / DEFER / GATE / BLOCK.
- Deep-Diff-Forge one-shot `review` / `rank` / `cluster` wrapper, malformed-patch typed failure, and patch-truth preservation flag.
- Pi extension entrypoint with `/codex-harness-status` plus first-slice tools.

Local checks:

```bash
cd pi-codex-habitat-harness
npm run selftest
npm run status -- ..
```

Do not run deploy, ship, push, DDF daemon start, DDF learn record, Fabric server, runbook execution, or factory dispatch without a separate explicit arming instruction.
