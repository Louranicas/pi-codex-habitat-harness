---
name: atuin-script-curation
description: "Audit, select, design, and validate reusable Atuin Scripts for the Codex Harness without blindly executing or registering them. Use when asked to reuse terminal workflows, inspect script adoption, turn repeated commands into a parameterized snippet, review an existing Atuin script, or decide whether a new script is justified."
---

# Atuin Script Curation

Prefer a small adopted script over another registry entry. The live registry is large and recorded direct adoption is sparse, so audit before creating.

## Workflow

1. Run `scripts/script-registry-audit.sh` to measure registry size, recorded direct runs, and risk-named entries without reading bodies or executing scripts.
2. Search `atuin scripts list` by name, description, and tags. Reuse an existing script when its contract matches.
3. Read the candidate body with `atuin scripts get NAME --script` and classify every command through the harness safety membrane.
4. Run source-level checks first. Execute only read-only scripts whose dependencies and outputs are understood.
5. Create a new script only for a repeated, stable workflow with a clear input/output contract and no better Just recipe or package helper.

## Authoring Contract

- Keep the body deterministic, bounded, `set -euo pipefail` where no-data is not expected, and explicit about read/write effects.
- Use Jinja-style `{{variable}}` placeholders and pass values with `atuin scripts run NAME -v key=value`.
- Do not embed credentials. Atuin sync is end-to-end encrypted, but script bodies and supplied variables still reach the local shell.
- Add precise tags such as `codex,harness,read-only,history`; avoid vague capability claims.
- Test the package-local source directly before any registration. Keep the reviewed file as source of truth.
- Do not build from `--last` blindly: history may contain secrets, flattened agent commands, partial pipelines, or synthetic success codes.

## Registration Boundary

Registration mutates the live Atuin store and requires explicit confirmation. The reviewed form is:

```bash
atuin scripts new NAME --description 'PURPOSE' --tags 'codex,harness,read-only' --shebang '/usr/bin/env bash' --script /reviewed/path.sh --no-edit
```

After registration, compare `atuin scripts get NAME --script` byte-for-byte with the reviewed source. Editing, renaming, and deletion require a new explicit request.

## Execution Boundary

- Never run scripts named or tagged for deploy, restart, dispatch, cascade, scale, register, import, retire, delete, format, wake, background monitoring, or service start without separate authority.
- Do not run a script merely because its metadata says read-only; inspect its body.
- Prefer Just for repository-owned workflows, S Loom tools for cognition, HSC for cache operations, and package scripts for harness validation.

Atuin Scripts support creation from commands/files, tags, descriptions, custom shebangs, Jinja variables, and encrypted sync. Source reference: `https://blog.atuin.sh/atuin-scripts-shareable-syncable-shell-snippets/`.

The verified metadata-only audit alias is `atuin scripts run codex-harness-script-audit`.
