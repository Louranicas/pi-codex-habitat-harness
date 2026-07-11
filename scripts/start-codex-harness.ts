import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { delimiter, dirname, resolve } from "node:path";
import { harnessStatus } from "../extensions/status.js";

interface StartOptions {
  checkOnly: boolean;
  launch: boolean;
  selftest: boolean;
  arena: boolean;
  json: boolean;
}

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = resolve(packageRoot, "..");
const provider = "openai-codex";
const model = "gpt-5.6-sol";
// Pi 0.80 exposes xhigh; nested Codex SDK calls use SOL's max effort.
const thinking = "xhigh";
const options = parseArgs(process.argv.slice(2));
const browserSession = process.env.PLAYWRIGHT_CLI_SESSION ?? `codex-harness-${process.pid}`;

function parseArgs(args: string[]): StartOptions {
  return {
    checkOnly: args.includes("--check-only"),
    launch: args.includes("--launch"),
    selftest: !args.includes("--no-selftest"),
    arena: !args.includes("--no-arena"),
    json: args.includes("--json"),
  };
}

function runStep(name: string, command: string, args: string[]): void {
  if (!options.json) console.log(`\n━━━ ${name} ━━━`);
  const result = spawnSync(command, args, { cwd: packageRoot, stdio: options.json ? "pipe" : "inherit", encoding: "utf8" });
  if (result.status !== 0) {
    if (options.json) {
      process.stderr.write(result.stderr ?? "");
      process.stdout.write(result.stdout ?? "");
    }
    throw new Error(`${name} failed with exit ${result.status ?? "signal"}`);
  }
}

function assertHardStops(status: Awaited<ReturnType<typeof harnessStatus>>): void {
  const hardStopsOk = status.hardStops.noDeployPushShip
    && status.hardStops.noFactoryAuthorizeWrite
    && status.hardStops.noDdfDaemonStart
    && status.hardStops.noFabricServer
    && status.s1008820.deployPushShipArmed === false;
  if (!hardStopsOk) throw new Error("hard-stop invariant failed; refusing to start harness");
}

async function main(): Promise<void> {
  if (!options.json) {
    console.log("Codex Pi Harness starter");
    console.log(`package=${packageRoot}`);
    console.log(`workspace=${workspaceRoot}`);
  }

  if (options.selftest) runStep("selftest", "npm", ["run", "selftest"]);
  if (options.arena) runStep("arena", "npm", ["run", "arena", "--", workspaceRoot]);

  const status = await harnessStatus(workspaceRoot);
  assertHardStops(status);
  if (status.status !== "ready_full_read_write_capacity") {
    throw new Error(`capacity status ${status.status}; expected ready_full_read_write_capacity`);
  }

  const summary = {
    status: status.status,
    latestReceiptHash: status.latestReceiptHash,
    receiptLedger: status.receiptLedger,
    writeCapacity: status.writeCapacity,
    hardStops: status.hardStops,
    runtime: {
      provider,
      model,
      piThinking: thinking,
      sdkReasoning: "max",
      packageMode: "project_settings_hot_reload",
      browser: {
        command: "playwright-cli",
        session: browserSession,
        mode: "isolated_headless",
        mcpRequired: false,
      },
    },
    launchCommand: "codex-harness",
  };

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log("\n━━━ capacity ready ━━━");
    console.log(JSON.stringify(summary, null, 2));
  }

  const shouldLaunch = !options.checkOnly && (options.launch || (process.stdin.isTTY && process.stdout.isTTY));
  if (!shouldLaunch) return;

  if (!options.json) console.log("\n━━━ launching hot-reloadable SOL 5.6 codex harness ━━━");
  const browserOutputDir = resolve(workspaceRoot, ".pi", "codex-harness", "browser");
  const launched = spawnSync("pi", ["--approve", "--provider", provider, "--model", model, "--thinking", thinking], {
    cwd: workspaceRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: [resolve(packageRoot, "node_modules", ".bin"), process.env.PATH].filter(Boolean).join(delimiter),
      PLAYWRIGHT_CLI_SESSION: browserSession,
      PLAYWRIGHT_MCP_CONFIG: process.env.PLAYWRIGHT_MCP_CONFIG ?? resolve(workspaceRoot, ".playwright", "cli.config.json"),
      PLAYWRIGHT_MCP_OUTPUT_DIR: process.env.PLAYWRIGHT_MCP_OUTPUT_DIR ?? browserOutputDir,
    },
  });
  process.exitCode = launched.status ?? 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (options.json) console.log(JSON.stringify({ status: "failed", error: message }, null, 2));
  else console.error(`start-codex-harness failed: ${message}`);
  process.exitCode = 1;
});
