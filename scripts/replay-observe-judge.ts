import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { runMacroJudge, type JudgeSeal, type SLobePlan } from "../extensions/codex-loom-tools.js";

const LIVE_TIMEOUT_MS = 480_000;
const workspace = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function resolveArtifact(input: string): string {
  const lexical = resolve(workspace, input);
  if (lstatSync(lexical).isSymbolicLink()) throw new Error(`judge replay artifact symlink refused: ${input}`);
  const canonical = realpathSync(lexical);
  const rel = relative(workspace, canonical);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`judge replay artifact outside workspace refused: ${input}`);
  if (!lstatSync(canonical).isFile()) throw new Error(`judge replay artifact must be a regular file: ${input}`);
  return canonical;
}

const ReplayArtifactSchema = z.object({
  objective: z.string().min(1).max(10_000),
  lobePlan: z.object({
    sphere: z.literal("stacked"),
    macro: z.object({ judgeBarrier: z.string() }).passthrough(),
    meso: z.array(z.object({ profile: z.string(), id: z.string(), purpose: z.string(), ports: z.unknown() }).passthrough()).min(1).max(5),
    micro: z.array(z.object({ profile: z.string(), roleId: z.string(), title: z.string(), evidenceContract: z.array(z.string()) }).passthrough()).min(2).max(5),
    geometry: z.object({ sharedMedium: z.string() }).passthrough(),
    sharedStateRule: z.string(),
    impactWeights: z.object({ correctness: z.number(), evidence: z.number(), lensDiversity: z.number(), memoryReuse: z.number(), latency: z.number() }),
  }).passthrough(),
  judgeSeals: z.array(z.object({
    profile: z.string().min(1).max(128),
    moduleId: z.string().min(1).max(128),
    roleId: z.string().min(1).max(128),
    persona: z.object({ id: z.string().min(1).max(128) }).passthrough(),
    source: z.enum(["live", "smart_cache"]),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    seal: z.object({
      role: z.string(),
      finding: z.string(),
      evidence: z.array(z.string()),
      risks: z.array(z.string()),
      recommendation: z.string(),
      confidence: z.number().min(0).max(1),
    }),
  }).passthrough()).min(2).max(5),
});

if (!process.argv.includes("--confirm-live")) {
  throw new Error("observe judge replay requires --confirm-live; this run makes up to two bounded SOL calls");
}

const artifactInput = argument("--artifact");
if (!artifactInput) throw new Error("observe judge replay requires --artifact <workspace-contained cluster artifact>");
const artifactPath = resolveArtifact(artifactInput);
const artifact = ReplayArtifactSchema.parse(JSON.parse(readFileSync(artifactPath, "utf8")) as unknown);

const result = await runMacroJudge({
  workingDirectory: workspace,
  objective: artifact.objective,
  plan: artifact.lobePlan as unknown as SLobePlan,
  judgeSeals: artifact.judgeSeals as unknown as JudgeSeal[],
  timeoutMs: LIVE_TIMEOUT_MS,
  reasoningEffort: "high",
});
const value = result.ok ? result.value as { verdict: string; acceptedLaneDigests: string[]; rejectedLaneDigests: string[] } : null;

console.log(JSON.stringify({
  artifact: artifactPath,
  timeoutMs: LIVE_TIMEOUT_MS,
  ok: result.ok,
  verdict: value?.verdict ?? null,
  acceptedLaneDigestCount: value?.acceptedLaneDigests.length ?? 0,
  rejectedLaneDigestCount: value?.rejectedLaneDigests.length ?? 0,
  error: result.error ?? null,
  diagnostics: result.diagnostics ?? null,
  attempts: result.attempts ?? [],
}, null, 2));

if (!result.ok) process.exitCode = 1;
