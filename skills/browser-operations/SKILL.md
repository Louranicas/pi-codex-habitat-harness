---
name: browser-operations
description: Drive and verify web interfaces through the Codex Harness terminal-first Playwright CLI. Use for browser inspection, UI debugging, end-to-end workflows, accessibility snapshots, responsive desktop/mobile checks, screenshots, console or network diagnosis, tracing, and browser evidence receipts. Prefer this skill over browser MCP unless the user explicitly needs an MCP-only workflow.
---

# Browser Operations

Use the local `playwright-cli` inherited by `codex-harness`. It keeps browser schemas out of the prompt, uses named isolated sessions, and writes evidence under `.pi/codex-harness/browser`.

## Start Safely

1. Call `codex_browser_inventory` before claiming browser capacity.
2. Treat local URLs as read-only by default. Obtain normal network approval before opening remote origins.
3. Open an isolated session: `playwright-cli -s=<task> open <url>`.
4. Use a fresh accessibility snapshot before each interaction. Element refs expire when the page changes.
5. Never put credentials, tokens, or private form values in shell arguments or evidence.

Do not attach an existing authenticated browser, load storage state, enable a persistent profile, upload files, accept downloads, or alter remote application state without explicit user authority. Never pass `--no-sandbox` or enable unrestricted file access.

## Verify The Interface

Inspect structure first:

```bash
playwright-cli -s=<task> snapshot
playwright-cli -s=<task> console warning
playwright-cli -s=<task> requests
```

Capture a stable desktop viewport:

```bash
playwright-cli -s=<task> resize 1440 900
playwright-cli -s=<task> screenshot
```

Create a separate mobile session instead of resizing an active desktop context:

```bash
playwright-cli -s=<task>-mobile open <url> --mobile
playwright-cli -s=<task>-mobile snapshot
playwright-cli -s=<task>-mobile screenshot
```

For canvas, 3D, chart, image, or layout work, inspect the screenshot with the available image-viewing tool. Accessibility snapshots alone cannot prove visual rendering, framing, or overlap.

## Interact Deliberately

Use current snapshot refs with `click`, `fill`, `select`, `check`, `hover`, or `generate-locator`. Re-snapshot after navigation or DOM mutation. Prefer semantic refs and generated locators over coordinate clicks.

For a remote state-changing action, describe the exact mutation and obtain user confirmation before the final click or submission. Record `remoteStateChanged=true` when sealing evidence.

## Diagnose And Record

Use console messages, requests, individual request/response inspection, and traces when screenshots do not explain a failure. Avoid recording secrets or response bodies containing private data.

After verification, call `codex_browser_evidence_seal` with the exact screenshot, snapshot, trace, console, or network artifact paths. A `pass` receipt requires evidence for every claimed viewport and state.

Close both sessions when finished:

```bash
playwright-cli -s=<task> close
playwright-cli -s=<task>-mobile close
```

Read [references/commands.md](references/commands.md) for session, evidence, network, trace, and authenticated attachment command patterns.
