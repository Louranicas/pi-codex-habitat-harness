# Playwright CLI Command Patterns

## Discovery

```bash
playwright-cli --version
playwright-cli --help
playwright-cli --help open
playwright-cli list
```

The harness supplies the local CLI on `PATH`, a unique default session, isolated headless Chrome, blocked service workers, and `.pi/codex-harness/browser` as the output directory.

## Navigation And State

```bash
playwright-cli -s=<task> open http://127.0.0.1:3000
playwright-cli -s=<task> goto <url>
playwright-cli -s=<task> reload
playwright-cli -s=<task> tab-list
playwright-cli -s=<task> tab-new <url>
playwright-cli -s=<task> close
```

Use `--headed` only when the user needs to observe or take over. Use `attach --cdp=chrome` or `attach --extension` only after explicit permission because it exposes authenticated tabs, cookies, and extensions.

## Snapshot And Interaction

```bash
playwright-cli -s=<task> snapshot
playwright-cli -s=<task> find "Submit"
playwright-cli -s=<task> generate-locator e12
playwright-cli -s=<task> click e12
playwright-cli -s=<task> fill e18 "non-secret value"
playwright-cli -s=<task> press Enter
```

Refs are valid only for the current page state. Snapshot again after each meaningful change.

## Visual Evidence

```bash
playwright-cli -s=<task> resize 1440 900
playwright-cli -s=<task> screenshot
playwright-cli -s=<task> screenshot e12
playwright-cli -s=<task> pdf
```

Pair a screenshot with a snapshot. Inspect image pixels for blank canvases, clipping, overlap, responsive breakage, and actual asset rendering.

## Console And Network

```bash
playwright-cli -s=<task> console warning
playwright-cli -s=<task> requests
playwright-cli -s=<task> request 7
playwright-cli -s=<task> response-headers 7
```

Do not capture sensitive request or response bodies. Use routing and offline state only for controlled test sessions:

```bash
playwright-cli -s=<task> route "**/api/example" --status=503
playwright-cli -s=<task> route-list
playwright-cli -s=<task> unroute "**/api/example"
playwright-cli -s=<task> network-state-set offline
playwright-cli -s=<task> network-state-set online
```

## Trace And Video

```bash
playwright-cli -s=<task> tracing-start
# perform the bounded workflow
playwright-cli -s=<task> tracing-stop
playwright-cli -s=<task> video-start
# perform the bounded workflow
playwright-cli -s=<task> video-stop
```

Seal only necessary artifacts. The harness limits evidence to 32 regular files, 64 MiB each, and 128 MiB total per receipt.
