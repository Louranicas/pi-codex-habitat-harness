import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPackageIdentity } from "./package-identity.js";
import { ddfStatus } from "./deep-diff-forge-review.js";
import { readLastReceiptHash, verifyReceiptLedger } from "./codex-receipts.js";

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
  const identity = await checkPackageIdentity(cwd);
  const ddf = ddfStatus(cwd);
  const ledger = await verifyReceiptLedger(cwd);
  const latestReceiptHash = await readLastReceiptHash(cwd);
  const authState = process.env.OPENAI_API_KEY ? "present" : "missing";
  return {
    status: identity.ok ? "ready_offline" : "refused_identity",
    s1008820: {
      planVersion: "v5",
      codingArmedThisTurn: true,
      deployPushShipArmed: false,
      buildScope: "first-slice-offline-judge-spine",
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
    substrateClass: "local_only",
    receiptCirculationClass: "local_file",
    latestReceiptHash,
    receiptLedger: ledger,
    ddf,
    hardStops: {
      noDeployPushShip: true,
      noFactoryAuthorizeWrite: true,
      noDdfDaemonStart: true,
      noFabricServer: true,
    },
  };
}
