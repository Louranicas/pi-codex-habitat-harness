import { existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { writeJsonArtifact } from "./codex-receipts.js";

export type DdfEngineState = "available_clean" | "available_dirty" | "unavailable" | "not_used";
export type DdfMode = "review" | "rank" | "cluster";
export type DdfTypedFailure = "parse_failure" | "usage_error" | "read_failure" | "daemon_failure" | "unknown_failure";

export interface DdfStatus {
  binary: string | null;
  version: string | null;
  selfTestOk: boolean;
  deployStatusSchema: string | null;
  engineState: DdfEngineState;
  errors: string[];
}

export interface DdfReviewResult {
  mode: DdfMode;
  exitCode: number;
  schema: string | null;
  stdout: string;
  stderr: string;
  parsed: unknown | null;
  patchTruthPreserved: true;
  typedFailure?: DdfTypedFailure;
}

export function resolveDdfBinary(workspaceCwd: string): string | null {
  const configured = process.env.CODEX_HARNESS_DDF_BINARY;
  if (configured && existsSync(configured)) return configured;
  const local = join(workspaceCwd, "deep-diff-forge", "target", "debug", "deep-diff-forge");
  if (existsSync(local)) return local;
  const pathResult = spawnSync("bash", ["-lc", "command -v deep-diff-forge"], { encoding: "utf8" });
  const candidate = pathResult.stdout.trim();
  return pathResult.status === 0 && candidate ? candidate : null;
}

export function ddfStatus(workspaceCwd: string): DdfStatus {
  const binary = resolveDdfBinary(workspaceCwd);
  const errors: string[] = [];
  if (!binary) {
    return { binary: null, version: null, selfTestOk: false, deployStatusSchema: null, engineState: "unavailable", errors: ["deep-diff-forge binary not found"] };
  }

  let version: string | null = null;
  let selfTestOk = false;
  let deployStatusSchema: string | null = null;

  try {
    version = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
  } catch (error) {
    errors.push(`version failed: ${(error as Error).message}`);
  }
  try {
    execFileSync(binary, ["--self-test"], { encoding: "utf8", timeout: 20_000 });
    selfTestOk = true;
  } catch (error) {
    errors.push(`self-test failed: ${(error as Error).message}`);
  }
  try {
    const raw = execFileSync(binary, ["deploy", "status", "--json"], { encoding: "utf8", timeout: 20_000 });
    const parsed = JSON.parse(raw) as { schema?: string };
    deployStatusSchema = typeof parsed.schema === "string" ? parsed.schema : null;
  } catch (error) {
    errors.push(`deploy status failed: ${(error as Error).message}`);
  }

  const repo = resolve(workspaceCwd, "deep-diff-forge");
  let engineState: DdfEngineState = errors.length === 0 && selfTestOk ? "available_clean" : "unavailable";
  if (existsSync(join(repo, ".git"))) {
    const dirty = spawnSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" });
    if (dirty.status === 0 && dirty.stdout.trim().length > 0 && engineState !== "unavailable") {
      engineState = "available_dirty";
    }
  }

  return { binary, version, selfTestOk, deployStatusSchema, engineState, errors };
}

export function reviewPatch(workspaceCwd: string, patch: string, mode: DdfMode): DdfReviewResult {
  const binary = resolveDdfBinary(workspaceCwd);
  if (!binary) {
    return { mode, exitCode: 127, schema: null, stdout: "", stderr: "deep-diff-forge binary not found", parsed: null, patchTruthPreserved: true, typedFailure: "unknown_failure" };
  }
  const args = mode === "review"
    ? ["--stdin-patch", "--json"]
    : mode === "rank"
      ? ["--stdin-patch", "--rank", "--json"]
      : ["--stdin-patch", "--cluster", "--parallel", "auto", "--json"];
  const result = spawnSync(binary, args, { input: patch, encoding: "utf8", timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const exitCode = typeof result.status === "number" ? result.status : 1;
  let parsed: unknown | null = null;
  let schema: string | null = null;
  try {
    parsed = stdout.trim() ? JSON.parse(stdout) : null;
    if (parsed && typeof parsed === "object" && "schema" in parsed) {
      const maybeSchema = (parsed as { schema?: unknown }).schema;
      schema = typeof maybeSchema === "string" ? maybeSchema : null;
    }
  } catch {
    parsed = null;
  }
  const output: DdfReviewResult = { mode, exitCode, schema, stdout, stderr, parsed, patchTruthPreserved: true };
  if (exitCode !== 0) output.typedFailure = classifyExit(exitCode);
  return output;
}

function classifyExit(code: number): DdfTypedFailure {
  if (code === 4) return "parse_failure";
  if (code === 2) return "usage_error";
  if (code === 3) return "read_failure";
  if (code === 6) return "daemon_failure";
  return "unknown_failure";
}

export async function writeDdfArtifact(workspaceCwd: string, result: DdfReviewResult): Promise<{ path: string; sha256: string }> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return writeJsonArtifact(workspaceCwd, `deep-diff-forge/${stamp}-${result.mode}.json`, {
    mode: result.mode,
    exitCode: result.exitCode,
    schema: result.schema,
    parsed: result.parsed,
    typedFailure: result.typedFailure ?? null,
    patchTruthPreserved: result.patchTruthPreserved,
  });
}
