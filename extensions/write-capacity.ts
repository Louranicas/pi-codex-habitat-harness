import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { appendReceipt } from "./codex-receipts.js";
import { classifyPermission, type PermissionClassification } from "./codex-safety-membrane.js";
import { createBaseEnvelope, type RunEnvelope } from "./run-envelope.js";

export interface WriteCapacityObservation {
  enabled: boolean;
  mode: "package_scoped_confirmed_write";
  packageRoot: string;
  proofPath: string;
  policyClass: PermissionClassification["class"];
  hardStopsPreserved: boolean;
  blockedRoutes: string[];
  errors: string[];
}

export interface ScopedWriteInput {
  cwd: string;
  relativePath: string;
  content: string;
  confirmWrite: boolean;
}

export interface ScopedWriteResult {
  path: string;
  sha256: string;
  bytes: number;
  verified: boolean;
  safety: PermissionClassification;
  receipt: {
    path: string;
    eventHash: string;
    verified: boolean;
  };
}

const BLOCKED_SEGMENTS = new Set([".git", "node_modules", "dist"]);
const BLOCKED_SUFFIXES = ["package-lock.json"];

export function packageRootFor(cwd: string): string {
  if (existsSync(join(cwd, "package.json")) && readPackageName(join(cwd, "package.json")) === "pi-codex-habitat-harness") return cwd;
  return join(cwd, "pi-codex-habitat-harness");
}

function readPackageName(path: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name : null;
  } catch {
    return null;
  }
}

export function resolveScopedWritePath(cwd: string, relativePath: string): string {
  if (isAbsolute(relativePath)) throw new Error(`absolute write path refused: ${relativePath}`);
  const packageRoot = packageRootFor(cwd);
  const resolved = resolve(packageRoot, relativePath);
  const rel = relative(packageRoot, resolved);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`outside package root refused: ${relativePath}`);
  const parts = rel.split(/[\\/]/g);
  if (parts.some((part) => BLOCKED_SEGMENTS.has(part))) throw new Error(`blocked package path segment: ${relativePath}`);
  if (BLOCKED_SUFFIXES.some((suffix) => rel === suffix || rel.endsWith(`/${suffix}`))) throw new Error(`blocked package manifest/lockfile path: ${relativePath}`);
  return resolved;
}

export function observeWriteCapacity(cwd: string): WriteCapacityObservation {
  const packageRoot = packageRootFor(cwd);
  const proofPath = ".pi/codex-harness/write-proofs/probe.json";
  const errors: string[] = [];
  if (!existsSync(packageRoot)) errors.push(`package root missing: ${packageRoot}`);
  const policy = classifyPermission({
    cwd: packageRoot,
    objective: "package scoped file update with explicit confirmation and receipt",
    path: proofPath,
    declaredPermissions: ["write"],
  });
  const blockedRoutes = ["deploy", "push", "ship", "factory.authorize", "deep-diff-forge daemon start", "fabric --serve"];
  const enabled = existsSync(packageRoot) && policy.class === "DEFER";
  return {
    enabled,
    mode: "package_scoped_confirmed_write",
    packageRoot,
    proofPath: join(packageRoot, proofPath),
    policyClass: policy.class,
    hardStopsPreserved: true,
    blockedRoutes,
    errors,
  };
}

export async function scopedWrite(input: ScopedWriteInput): Promise<ScopedWriteResult> {
  if (!input.confirmWrite) throw new Error("confirmWrite=true is required for package-scoped writes");
  const packageRoot = packageRootFor(input.cwd);
  const target = resolveScopedWritePath(input.cwd, input.relativePath);
  const relTarget = relative(packageRoot, target);
  const safety = classifyPermission({
    cwd: packageRoot,
    objective: "package scoped file update with explicit confirmation and receipt",
    path: relTarget,
    declaredPermissions: ["write"],
    observedEffects: [relTarget],
  });
  if (safety.class === "BLOCK" || safety.class === "GATE") throw new Error(`write refused by safety membrane: ${safety.class}: ${safety.reason}`);

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, input.content, "utf8");
  const readBack = await readFile(target, "utf8");
  const sha256 = createHash("sha256").update(readBack).digest("hex");
  const verified = readBack === input.content;

  const envelope = createBaseEnvelope({
    cwd: input.cwd,
    objective: `Package-scoped write ${relTarget}`,
    kind: "review",
    verdict: verified ? "pass" : "fail",
    safety: {
      class: safety.class,
      reason: `${safety.reason}; explicit confirmWrite=true; deploy/push/ship remain blocked`,
      declaredPermissions: safety.declaredPermissions,
      observedEffects: safety.observedEffects,
      permissionDelta: safety.permissionDelta,
    },
  });
  envelope.substrateClass = "habitat_observed";
  envelope.receiptCirculationClass = "local_file";
  envelope.artifacts.push({ path: target, sha256 });
  const receipt = await appendReceipt(input.cwd, envelope as RunEnvelope);
  return { path: target, sha256, bytes: Buffer.byteLength(readBack), verified, safety, receipt: { path: receipt.path, eventHash: receipt.eventHash, verified: receipt.verified } };
}
