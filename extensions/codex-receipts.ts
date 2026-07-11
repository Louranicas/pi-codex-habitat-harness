import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { ARTIFACT_ROOT } from "./constants.js";
import { finalizeEnvelopeHash, RunEnvelopeSchema, sha256, stableJson, type RunEnvelope } from "./run-envelope.js";

const SECRET_KEY_PATTERN = /(api[_-]?key|token|secret|password|authorization)/i;
const SECRET_VALUE_PATTERNS = [
  /sk-[A-Za-z0-9_\-]{12,}/g,
  /Bearer\s+[A-Za-z0-9._\-]{12,}/g,
  /OPENAI_API_KEY\s*=\s*[^\s]+/g,
];

export interface ReceiptWriteResult {
  path: string;
  eventHash: string;
  prevHash: string | null;
  verified: boolean;
  envelope: RunEnvelope;
}

export function receiptDir(cwd: string): string {
  return join(cwd, ARTIFACT_ROOT, "receipts");
}

export function receiptLedgerPath(cwd: string): string {
  return join(receiptDir(cwd), "codex-pi-harness-receipts.jsonl");
}

export function redactSecrets<T>(value: T): T {
  return redact(value) as T;
}

function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return SECRET_VALUE_PATTERNS.reduce((current, pattern) => current.replace(pattern, "[REDACTED]"), value);
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, inner]) => {
      if (SECRET_KEY_PATTERN.test(key)) return [key, "[REDACTED]"];
      return [key, redact(inner)];
    });
    return Object.fromEntries(entries);
  }
  return value;
}

export async function readLastReceipt(cwd: string): Promise<RunEnvelope | null> {
  const path = receiptLedgerPath(cwd);
  if (!existsSync(path)) return null;
  const text = await readFile(path, "utf8");
  const lines = text.trim().split("\n").filter(Boolean);
  if (lines.length === 0) return null;
  return RunEnvelopeSchema.parse(JSON.parse(lines[lines.length - 1] ?? "{}"));
}

export async function readLastReceiptHash(cwd: string): Promise<string | null> {
  const last = await readLastReceipt(cwd);
  return last?.eventHash ?? null;
}

export async function readLastReceiptCirculationClass(cwd: string): Promise<RunEnvelope["receiptCirculationClass"] | null> {
  const last = await readLastReceipt(cwd);
  return last?.receiptCirculationClass ?? null;
}

export async function strongestReceiptCirculationClass(cwd: string): Promise<RunEnvelope["receiptCirculationClass"]> {
  const path = receiptLedgerPath(cwd);
  if (!existsSync(path)) return "local_file";
  const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
  let best: RunEnvelope["receiptCirculationClass"] = "local_file";
  for (const line of lines) {
    try {
      const parsed = RunEnvelopeSchema.parse(JSON.parse(line));
      if (parsed.receiptCirculationClass === "factory_integrated") return "factory_integrated";
      if (parsed.receiptCirculationClass === "habitat_observed") best = "habitat_observed";
    } catch {
      // Ledger validation reports malformed lines separately; status stays fail-soft.
    }
  }
  return best;
}

export async function appendReceipt(cwd: string, envelope: RunEnvelope): Promise<ReceiptWriteResult> {
  const redacted = redactSecrets(envelope);
  const parsed = RunEnvelopeSchema.parse(redacted);
  const prevHash = await readLastReceiptHash(cwd);
  const finalized = finalizeEnvelopeHash(parsed, prevHash);
  const path = receiptLedgerPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  const prior = existsSync(path) ? await readFile(path, "utf8") : "";
  const line = `${JSON.stringify(finalized)}\n`;
  await writeFile(path, prior + line, "utf8");
  const readBack = await readFile(path, "utf8");
  const verified = readBack.endsWith(line);
  return { path, eventHash: finalized.eventHash, prevHash, verified, envelope: finalized };
}

export async function verifyReceiptLedger(cwd: string): Promise<{ ok: boolean; count: number; errors: string[] }> {
  const path = receiptLedgerPath(cwd);
  if (!existsSync(path)) return { ok: true, count: 0, errors: [] };
  const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
  const errors: string[] = [];
  let previous: string | null = null;
  for (const [index, line] of lines.entries()) {
    try {
      const parsed = RunEnvelopeSchema.parse(JSON.parse(line));
      if (parsed.prevHash !== previous) {
        errors.push(`line ${index + 1}: prevHash ${parsed.prevHash ?? "null"} did not match ${previous ?? "null"}`);
      }
      const recomputed = sha256(stableJson({ ...parsed, eventHash: "pending" }));
      if (parsed.eventHash !== recomputed) {
        errors.push(`line ${index + 1}: eventHash mismatch`);
      }
      previous = parsed.eventHash;
    } catch (error) {
      errors.push(`line ${index + 1}: ${(error as Error).message}`);
    }
  }
  return { ok: errors.length === 0, count: lines.length, errors };
}

export async function writeJsonArtifact(cwd: string, relativePath: string, value: unknown): Promise<{ path: string; sha256: string }> {
  const path = join(cwd, ARTIFACT_ROOT, relativePath);
  await mkdir(dirname(path), { recursive: true });
  const content = `${JSON.stringify(redactSecrets(value), null, 2)}\n`;
  await writeFile(path, content, "utf8");
  return { path, sha256: sha256(content) };
}
