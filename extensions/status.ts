import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { actorBridgeStatus } from "./actor-bridges.js";
import { checkPackageIdentity, workspaceRootFor } from "./package-identity.js";
import { ddfStatus } from "./deep-diff-forge-review.js";
import { observeHabitat } from "./habitat-observation.js";
import { observeWriteCapacity } from "./write-capacity.js";
import { readLastReceiptCirculationClass, readLastReceiptHash, verifyReceiptLedger } from "./codex-receipts.js";
import { loadSLoomRoster } from "./s-loom-roster.js";

const require = createRequire(import.meta.url);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function optionalPackageVersion(pkg: string): string | null {
  const directPath = join(packageRoot, "node_modules", ...pkg.split("/"), "package.json");
  try {
    return JSON.parse(readFileSync(directPath, "utf8")).version as string;
  } catch {
    try {
      return require(`${pkg}/package.json`).version as string;
    } catch {
      return null;
    }
  }
}

function optionalCommand(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, { encoding: "utf8", timeout: 10_000 }).trim();
  } catch {
    return null;
  }
}

export async function harnessStatus(cwd: string) {
  const workspaceCwd = workspaceRootFor(cwd);
  const identity = await checkPackageIdentity(workspaceCwd);
  const ddf = ddfStatus(workspaceCwd);
  const habitat = await observeHabitat(workspaceCwd);
  const ledger = await verifyReceiptLedger(workspaceCwd);
  const latestReceiptHash = await readLastReceiptHash(workspaceCwd);
  const authState = process.env.OPENAI_API_KEY ? "present" : "missing";
  const habitatObserved = habitat.substrateClass === "habitat_observed";
  const readOnlyCapacityGates = ["GATE-08", "GATE-14", "GATE-18", "GATE-19", "GATE-20"].every((gate) => habitat.gates[gate] === "pass");
  const writeCapacity = observeWriteCapacity(workspaceCwd);
  const readWriteCapacity = readOnlyCapacityGates && writeCapacity.enabled && writeCapacity.hardStopsPreserved;
  const actorBridges = actorBridgeStatus(workspaceCwd);
  const sLoomRoster = loadSLoomRoster();
  const receiptCirculationClass = (await readLastReceiptCirculationClass(workspaceCwd)) ?? "local_file";
  return {
    status: identity.ok ? (habitatObserved && readWriteCapacity ? "ready_full_read_write_capacity" : habitatObserved && readOnlyCapacityGates ? "ready_full_readonly_capacity" : habitatObserved ? "ready_habitat_observed" : "ready_offline") : "refused_identity",
    s1008820: {
      planVersion: "v5",
      codingArmedThisTurn: true,
      deployPushShipArmed: false,
      buildScope: "sol56-terminal-workspace-write-confirmed-no-deploy-push-ship",
    },
    runtimeProfile: {
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      piThinking: "xhigh",
      sdkReasoning: "max",
      sdk: "0.144.0",
      terminalFirst: true,
      workspaceWrite: "confirmation_gated",
      network: "confirmation_gated_default_off",
      packageMode: "project_settings_hot_reload",
      reloadCommand: "/reload",
      loomLatticeMaturity: "wip_deployment_not_operational_dependency",
      browserAutomation: "terminal_first_playwright_cli",
    },
    sLoomRoster: {
      id: sLoomRoster.id,
      version: sLoomRoster.version,
      status: sLoomRoster.status,
      profiles: Object.keys(sLoomRoster.looms),
      model: sLoomRoster.runtime.model,
      smartCacheFamilies: Object.values(sLoomRoster.looms).map((loom) => loom.cache.family),
      personaHotSwapSource: sLoomRoster.personaHotSwap.source,
      observabilityProfile: sLoomRoster.looms.observe?.id ?? null,
      habitatRosterAuthority: sLoomRoster.authority.habitatOperationalRoster,
    },
    atuin: {
      version: optionalCommand("atuin", ["--version"]),
      executionPlane: "direct_terminal",
      mcpRequired: false,
      skills: ["atuin-history-intelligence", "atuin-kv-coordination", "atuin-script-curation"],
      defaultPolicy: "read_only_aggregate_then_explicit_authority_for_writes_or_script_registration",
    },
    browser: {
      playwrightCli: optionalPackageVersion("@playwright/cli"),
      playwrightCore: optionalPackageVersion("playwright-core"),
      executionPlane: "direct_terminal",
      mcpRequired: false,
      configPath: join(workspaceCwd, ".playwright", "cli.config.json"),
      configPresent: existsSync(join(workspaceCwd, ".playwright", "cli.config.json")),
      skill: "browser-operations",
      defaultPolicy: "isolated_headless_read_only_evidence_first",
    },
    identity,
    versions: {
      node: process.version,
      pi: optionalCommand("pi", ["--version"]),
      codexCli: optionalCommand("codex", ["--version"]),
      codexSdk: optionalPackageVersion("@openai/codex-sdk"),
      openaiAgentsTs: optionalPackageVersion("@openai/agents"),
      zod: optionalPackageVersion("zod"),
      zellij: optionalCommand("zellij", ["--version"]),
    },
    authState,
    substrateClass: habitat.substrateClass,
    receiptCirculationClass,
    latestReceiptHash,
    receiptLedger: ledger,
    actorBridges,
    ddf,
    habitat,
    writeCapacity,
    hardStops: {
      noDeployPushShip: true,
      noFactoryAuthorizeWrite: true,
      noDdfDaemonStart: true,
      noFabricServer: true,
    },
  };
}
