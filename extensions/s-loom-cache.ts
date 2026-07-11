import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { redactSecrets } from "./codex-receipts.js";
import type { ResolvedSLoomRole, SLoomModule } from "./s-loom-roster.js";

const SLoomMemoryEntrySchema = z.object({
  schema: z.literal("codex-harness.s-loom-memory.v1"),
  kind: z.literal("judged_lane_seal"),
  rosterSha256: z.string().length(64),
  moduleSha256: z.string().length(64),
  personaSha256: z.string().length(64),
  workspaceSha256: z.string().length(64),
  objectiveSha256: z.string().length(64),
  profile: z.string(),
  moduleId: z.string(),
  roleId: z.string(),
  personaId: z.string(),
  family: z.string(),
  key: z.string(),
  namespace: z.string(),
  laneDigest: z.string().length(64),
  judgeVerdict: z.literal("proceed"),
  proofRef: z.string().min(1),
  value: z.unknown(),
});

const HscEnvelopeSchema = z.object({
  v: z.literal(1),
  family: z.string(),
  key: z.string(),
  content_sha: z.string().length(64),
  source: z.string(),
  provenance: z.array(z.string()).min(1),
  class: z.literal("causal"),
  payload: z.unknown(),
}).passthrough();

export type SLoomCacheMode = "use" | "refresh" | "off";
export type SLoomMemoryEntry = z.infer<typeof SLoomMemoryEntrySchema>;

export interface SLoomCacheBinding {
  family: string;
  key: string;
  objectiveSha256: string;
  workspaceSha256: string;
  rosterSha256: string;
  moduleSha256: string;
  personaSha256: string;
  namespace: string;
  profile: string;
  moduleId: string;
  roleId: string;
  personaId: string;
}

export interface SLoomCacheRead {
  state: "hit" | "miss" | "stale" | "unavailable" | "invalid" | "bypassed";
  binding: SLoomCacheBinding;
  entry?: SLoomMemoryEntry;
  error?: string;
  elapsedMs: number;
}

export interface SLoomCacheWrite {
  state: "written" | "unavailable" | "refused" | "failed" | "bypassed";
  binding: SLoomCacheBinding;
  class: "causal";
  error?: string;
  elapsedMs: number;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digestSLoomMemoryValue(value: unknown): string {
  return hashText(canonicalJson(value));
}

export function digestSLoomLaneSeal(identity: Pick<SLoomCacheBinding, "profile" | "moduleId" | "roleId" | "personaId" | "family" | "key" | "namespace" | "objectiveSha256" | "workspaceSha256" | "rosterSha256" | "moduleSha256" | "personaSha256">, value: unknown): string {
  return digestSLoomMemoryValue({
    profile: identity.profile,
    moduleId: identity.moduleId,
    roleId: identity.roleId,
    personaId: identity.personaId,
    family: identity.family,
    key: identity.key,
    namespace: identity.namespace,
    objectiveSha256: identity.objectiveSha256,
    workspaceSha256: identity.workspaceSha256,
    rosterSha256: identity.rosterSha256,
    moduleSha256: identity.moduleSha256,
    personaSha256: identity.personaSha256,
    seal: value,
  });
}

function commandOutput(command: string, args: string[], cwd: string, timeoutMs = 15_000): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function assertContainedRealPath(cacheRoot: string, candidate: string, label: string): string {
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch (error) {
    throw new Error(`${label} cannot be resolved; smart-cache reuse disabled: ${error instanceof Error ? error.message : String(error)}`);
  }
  const rel = relative(cacheRoot, real);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${label} resolves outside the Git workspace; smart-cache reuse disabled: ${candidate} -> ${real}`);
  return real;
}

function hashLiveTree(digest: ReturnType<typeof createHash>, cacheRoot: string, candidate: string, label: string, budget: { remainingBytes: number }): void {
  const real = assertContainedRealPath(cacheRoot, candidate, label);
  const stat = lstatSync(real);
  digest.update(label).update("\0").update(relative(cacheRoot, real)).update("\0").update(String(stat.mode)).update("\0").update(String(stat.size)).update("\0");
  if (stat.isFile()) {
    if (stat.size > budget.remainingBytes) throw new Error(`${label} exceeds the 16 MiB full-hash budget; smart-cache reuse disabled`);
    digest.update(readFileSync(real));
    budget.remainingBytes -= stat.size;
    return;
  }
  if (!stat.isDirectory()) throw new Error(`${label} resolves to an unsupported file type; smart-cache reuse disabled`);
  for (const name of readdirSync(real).sort()) {
    const child = join(real, name);
    const childStat = lstatSync(child);
    if (childStat.isSymbolicLink()) throw new Error(`${label} contains a nested symlink; smart-cache reuse disabled: ${child}`);
    hashLiveTree(digest, cacheRoot, child, `${label}/${name}`, budget);
  }
}

function proofArtifactError(workspace: string, proofRef: string): string | null {
  const marker = "@sha256:";
  const markerIndex = proofRef.lastIndexOf(marker);
  if (markerIndex <= 0) return "cache proofRef must be <artifact-path>@sha256:<digest>";
  const artifactPath = proofRef.slice(0, markerIndex);
  const expectedSha256 = proofRef.slice(markerIndex + marker.length);
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) return "cache proofRef has an invalid SHA-256 digest";
  try {
    const workspaceRoot = realpathSync(workspace);
    const candidate = isAbsolute(artifactPath) ? artifactPath : resolve(workspaceRoot, artifactPath);
    const originalStat = lstatSync(candidate);
    if (originalStat.isSymbolicLink() || !originalStat.isFile()) return "cache proof artifact must be a regular non-symlink file";
    const real = assertContainedRealPath(workspaceRoot, candidate, "cache proof artifact");
    const actualSha256 = createHash("sha256").update(readFileSync(real)).digest("hex");
    return actualSha256 === expectedSha256 ? null : "cache proof artifact hash does not match proofRef";
  } catch (error) {
    return `cache proof artifact cannot be verified: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function workspaceStateSha(workingDirectory: string, cacheRelevantIgnoredPaths: string[] = []): string {
  const absoluteWorkingDirectory = resolve(workingDirectory);
  const rootResult = commandOutput("git", ["-C", absoluteWorkingDirectory, "rev-parse", "--show-toplevel"], absoluteWorkingDirectory);
  if (rootResult.status !== 0 || !rootResult.stdout.trim()) throw new Error("workspace Git root cannot be resolved; smart-cache reuse disabled");
  const cacheRoot = realpathSync(rootResult.stdout.trim());
  const head = commandOutput("git", ["-C", cacheRoot, "rev-parse", "HEAD"], cacheRoot);
  const status = commandOutput("git", ["-C", cacheRoot, "status", "--porcelain=v1", "-z", "--ignore-submodules=none"], cacheRoot);
  const diff = commandOutput("git", ["-C", cacheRoot, "diff", "--no-ext-diff", "--binary", "--ignore-submodules=none", "HEAD", "--"], cacheRoot, 30_000);
  if (head.status !== 0 || status.status !== 0 || diff.status !== 0) throw new Error("workspace state cannot be fully read; smart-cache reuse disabled");
  if (/^[+-]Subproject commit [0-9a-f]+-dirty$/m.test(diff.stdout)) throw new Error("dirty Git submodule content is not fully represented by the parent diff; smart-cache reuse disabled");

  const digest = createHash("sha256").update(head.stdout).update("\0").update(status.stdout).update("\0").update(diff.stdout);
  const budget = { remainingBytes: 16 * 1024 * 1024 };
  const index = commandOutput("git", ["-C", cacheRoot, "ls-files", "-s", "-z"], cacheRoot);
  if (index.status !== 0) throw new Error("tracked workspace modes cannot be enumerated; smart-cache reuse disabled");
  for (const record of index.stdout.split("\0").filter(Boolean).sort()) {
    const tab = record.indexOf("\t");
    const header = tab >= 0 ? record.slice(0, tab) : "";
    const relativePath = tab >= 0 ? record.slice(tab + 1) : "";
    const mode = header.split(" ", 1)[0];
    if (mode !== "120000") continue;
    const candidate = resolve(cacheRoot, relativePath);
    const stat = lstatSync(candidate);
    if (!stat.isSymbolicLink()) throw new Error(`tracked symlink index/worktree mismatch; smart-cache reuse disabled: ${relativePath}`);
    const target = readlinkSync(candidate);
    digest.update(`tracked-symlink:${relativePath}`).update("\0").update(target).update("\0");
    hashLiveTree(digest, cacheRoot, candidate, `tracked-symlink-target:${relativePath}`, budget);
  }
  const untracked = commandOutput("git", ["-C", cacheRoot, "ls-files", "--others", "--exclude-standard", "-z"], cacheRoot);
  if (untracked.status !== 0) throw new Error("untracked workspace content cannot be enumerated; smart-cache reuse disabled");
  for (const relativePath of untracked.stdout.split("\0").filter(Boolean).sort()) {
    const candidate = resolve(cacheRoot, relativePath);
    const rel = relative(cacheRoot, candidate);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`untracked path escapes working directory: ${relativePath}`);
    const stat = lstatSync(candidate);
    digest.update(relativePath).update("\0").update(String(stat.size)).update("\0");
    if (stat.isSymbolicLink()) {
      throw new Error(`untracked symlink requires live inspection; smart-cache reuse disabled: ${relativePath} -> ${readlinkSync(candidate)}`);
    } else if (stat.isFile()) {
      if (stat.size > budget.remainingBytes) throw new Error("untracked content exceeds the 16 MiB full-hash budget; smart-cache reuse disabled");
      digest.update(readFileSync(candidate));
      budget.remainingBytes -= stat.size;
    } else {
      digest.update(`type:${stat.mode}`);
    }
  }
  for (const relativePath of [...new Set(cacheRelevantIgnoredPaths)].sort()) {
    const candidate = resolve(cacheRoot, relativePath);
    const rel = relative(cacheRoot, candidate);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`cache-relevant ignored path escapes working directory: ${relativePath}`);
    digest.update(`ignored:${relativePath}`).update("\0");
    if (!existsSync(candidate)) {
      digest.update("absent");
      continue;
    }
    const stat = lstatSync(candidate);
    digest.update(String(stat.size)).update("\0");
    if (stat.isSymbolicLink()) {
      throw new Error(`cache-relevant ignored symlink requires live inspection; smart-cache reuse disabled: ${relativePath} -> ${readlinkSync(candidate)}`);
    } else if (stat.isFile()) {
      if (stat.size > budget.remainingBytes) throw new Error("cache-relevant ignored content exceeds the 16 MiB full-hash budget; smart-cache reuse disabled");
      digest.update(readFileSync(candidate));
      budget.remainingBytes -= stat.size;
    } else {
      throw new Error(`cache-relevant ignored path is not a file or symlink: ${relativePath}`);
    }
  }
  return digest.digest("hex");
}

export function createCacheBinding(module: SLoomModule, role: ResolvedSLoomRole, objective: string, workingDirectory: string, rosterSha256: string, moduleSha256: string, knownWorkspaceSha256?: string): SLoomCacheBinding {
  const objectiveSha256 = hashText(objective);
  const workspaceSha256 = knownWorkspaceSha256 ?? workspaceStateSha(workingDirectory);
  const key = [module.id, role.id, role.personaGenome.id, workspaceSha256.slice(0, 16), objectiveSha256.slice(0, 16)].join(":");
  return { family: module.cache.family, key, objectiveSha256, workspaceSha256, rosterSha256, moduleSha256, personaSha256: role.personaSha256, namespace: role.memory.namespace, profile: role.profile, moduleId: module.id, roleId: role.id, personaId: role.personaGenome.id };
}

function hscBinary(workspace: string): string | null {
  const binary = join(workspace, "bin", "hsc");
  return existsSync(binary) ? binary : null;
}

export function readSLoomCache(workspace: string, binding: SLoomCacheBinding, mode: SLoomCacheMode): SLoomCacheRead {
  const started = performance.now();
  if (mode !== "use") return { state: "bypassed", binding, elapsedMs: performance.now() - started };
  const binary = hscBinary(workspace);
  if (!binary) return { state: "unavailable", binding, error: "bin/hsc not found", elapsedMs: performance.now() - started };
  let result = commandOutput(binary, ["get", binding.family, binding.key], workspace);
  if (result.status === 2) {
    const replay = commandOutput(binary, ["replay", binding.family], workspace, 30_000);
    if (replay.status === 0) result = commandOutput(binary, ["get", binding.family, binding.key], workspace);
  }
  if (result.status === 2) return { state: "miss", binding, elapsedMs: performance.now() - started };
  if (result.status === 3) return { state: "stale", binding, elapsedMs: performance.now() - started };
  if (result.status !== 0) return { state: "unavailable", binding, error: result.stderr.trim() || `hsc get exit ${result.status}`, elapsedMs: performance.now() - started };
  try {
    const envelope = HscEnvelopeSchema.parse(JSON.parse(result.stdout));
    if (envelope.family !== binding.family || envelope.key !== binding.key || envelope.source !== binding.namespace || hashText(JSON.stringify(envelope.payload)) !== envelope.content_sha) return { state: "invalid", binding, error: "HSC outer envelope class, identity, source, or content hash is invalid", elapsedMs: performance.now() - started };
    const entry = SLoomMemoryEntrySchema.parse(envelope.payload);
    const bindingMatches = entry.rosterSha256 === binding.rosterSha256 && entry.moduleSha256 === binding.moduleSha256 && entry.personaSha256 === binding.personaSha256 && entry.workspaceSha256 === binding.workspaceSha256 && entry.objectiveSha256 === binding.objectiveSha256 && entry.family === binding.family && entry.key === binding.key && entry.namespace === binding.namespace && entry.profile === binding.profile && entry.moduleId === binding.moduleId && entry.roleId === binding.roleId && entry.personaId === binding.personaId;
    if (!bindingMatches) return { state: "invalid", binding, error: "cache identity or provenance does not match current binding", elapsedMs: performance.now() - started };
    if (digestSLoomLaneSeal(binding, entry.value) !== entry.laneDigest) return { state: "invalid", binding, error: "cache lane identity digest is invalid", elapsedMs: performance.now() - started };
    const proofError = proofArtifactError(workspace, entry.proofRef);
    if (proofError) return { state: "invalid", binding, error: proofError, elapsedMs: performance.now() - started };
    return { state: "hit", binding, entry, elapsedMs: performance.now() - started };
  } catch (error) {
    return { state: "invalid", binding, error: error instanceof Error ? error.message : String(error), elapsedMs: performance.now() - started };
  }
}

export function writeSLoomCache(workspace: string, binding: SLoomCacheBinding, role: ResolvedSLoomRole, kind: "judged_lane_seal", value: unknown, proofRef: string, judgeVerdict: "proceed" | "revise" | "collapse" | null, mode: SLoomCacheMode, acceptedLaneDigest?: string): SLoomCacheWrite {
  const started = performance.now();
  const cacheClass = "causal" as const;
  if (mode === "off") return { state: "bypassed", binding, class: cacheClass, elapsedMs: performance.now() - started };
  if (kind !== "judged_lane_seal") return { state: "refused", binding, class: cacheClass, error: "S Loom cache refuses failure/trap admission", elapsedMs: performance.now() - started };
  const binary = hscBinary(workspace);
  if (!binary) return { state: "unavailable", binding, class: cacheClass, error: "bin/hsc not found", elapsedMs: performance.now() - started };
  const proofError = proofArtifactError(workspace, proofRef);
  if (proofError) return { state: "refused", binding, class: cacheClass, error: proofError, elapsedMs: performance.now() - started };
  const safeValue = redactSecrets(value);
  const laneDigest = digestSLoomLaneSeal(binding, safeValue);
  if (judgeVerdict !== "proceed" || acceptedLaneDigest !== laneDigest) return { state: "refused", binding, class: cacheClass, error: "cache admission requires a proceed verdict and exact judge-accepted lane identity digest", elapsedMs: performance.now() - started };
  const entry = redactSecrets({
    schema: "codex-harness.s-loom-memory.v1",
    kind,
    rosterSha256: binding.rosterSha256,
    moduleSha256: binding.moduleSha256,
    personaSha256: binding.personaSha256,
    workspaceSha256: binding.workspaceSha256,
    objectiveSha256: binding.objectiveSha256,
    profile: role.profile,
    moduleId: binding.moduleId,
    roleId: role.id,
    personaId: role.personaGenome.id,
    family: binding.family,
    key: binding.key,
    namespace: binding.namespace,
    laneDigest,
    judgeVerdict,
    proofRef,
    value: safeValue,
  });
  const parsed = SLoomMemoryEntrySchema.safeParse(entry);
  if (!parsed.success) return { state: "refused", binding, class: cacheClass, error: parsed.error.message, elapsedMs: performance.now() - started };
  const lockPath = join(tmpdir(), `codex-harness-${binding.family}.lock`);
  const provenance = [
    `artifact:${proofRef}`,
    `s-roster:sha256:${binding.rosterSha256}`,
    `s-module:sha256:${binding.moduleSha256}`,
    `persona:${role.personaGenome.id}@sha256:${binding.personaSha256}`,
    `workspace-state:sha256:${binding.workspaceSha256}`,
  ];
  const args = ["-w", "10", lockPath, binary, "put", binding.family, binding.key, "--class", cacheClass, "--source", role.memory.namespace, "--ttl", String(role.memory.ttlSeconds), "--relevance", "0.8"];
  for (const item of provenance) args.push("--provenance", item);
  const result = spawnSync("flock", args, { cwd: workspace, input: JSON.stringify(parsed.data), encoding: "utf8", timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });
  if (result.status === 0) return { state: "written", binding, class: cacheClass, elapsedMs: performance.now() - started };
  return { state: result.status === 4 ? "refused" : "failed", binding, class: cacheClass, error: (result.stderr ?? "").trim() || `hsc put exit ${result.status}`, elapsedMs: performance.now() - started };
}
