import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkPackageIdentity } from "../extensions/package-identity.js";
import { appendReceipt, redactSecrets, verifyReceiptLedger } from "../extensions/codex-receipts.js";
import { classifyPermission } from "../extensions/codex-safety-membrane.js";
import { reviewPatch, ddfStatus } from "../extensions/deep-diff-forge-review.js";
import codexPiHarnessExtension from "../extensions/index.js";
import { createBaseEnvelope, RunEnvelopeSchema } from "../extensions/run-envelope.js";

const workspace = resolve("..");
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codex-harness-test-"));
  tempRoots.push(dir);
  await mkdir(join(dir, "pi-codex-habitat-harness"), { recursive: true });
  return dir;
}

describe("S1008820 first-slice offline judge spine", () => {
  it("loads the Pi extension entrypoint and registers first-slice commands/tools", () => {
    const commands: string[] = [];
    const tools: string[] = [];
    codexPiHarnessExtension({
      registerCommand: (name: string) => commands.push(name),
      registerTool: (definition: Record<string, unknown>) => tools.push(String(definition.name)),
    });
    expect(commands).toContain("codex-harness-status");
    expect(tools).toEqual(expect.arrayContaining(["codex_harness_status", "codex_permission_classify", "codex_receipt_write", "ddf_status", "ddf_review_patch"]));
  });

  it("accepts canonical package identity and refuses alternate roots", async () => {
    const cwd = await tempWorkspace();
    let identity = await checkPackageIdentity(cwd);
    expect(identity.ok).toBe(true);

    await mkdir(join(cwd, ".pi-codex-habitat-harness"));
    identity = await checkPackageIdentity(cwd);
    expect(identity.ok).toBe(false);
    expect(identity.refusalReason).toContain("forbidden alternate root");
  });

  it("classifies read-only review as AUTO and daemon start as BLOCK", () => {
    expect(classifyPermission({ cwd: workspace, objective: "review patch status", declaredPermissions: ["read"] }).class).toBe("AUTO");
    expect(classifyPermission({ cwd: workspace, objective: "start daemon", command: "deep-diff-forge daemon start" }).class).toBe("BLOCK");
    expect(classifyPermission({ cwd: workspace, objective: "write outside", path: "../outside.txt" }).class).toBe("BLOCK");
  });

  it("writes redacted hash-chained receipts and verifies read-back", async () => {
    const cwd = await tempWorkspace();
    const envelope = createBaseEnvelope({
      cwd,
      objective: "redact OPENAI_API_KEY=fixture-openai-api-key-value",
      verdict: "pass",
    });
    envelope.artifacts.push({ path: "provider", sha256: "0".repeat(64) });
    const written = await appendReceipt(cwd, envelope);
    expect(written.verified).toBe(true);
    expect(written.eventHash).toMatch(/^[a-f0-9]{64}$/);

    const ledger = await verifyReceiptLedger(cwd);
    expect(ledger.ok).toBe(true);
    expect(ledger.count).toBe(1);

    const text = await readFile(written.path, "utf8");
    expect(text).not.toContain("fixture-openai-api-key-value");
    expect(redactSecrets({ api_key: "fixture-openai-api-key-value" })).toEqual({ api_key: "[REDACTED]" });
  });

  it("validates the base RunEnvelope contract", () => {
    const envelope = createBaseEnvelope({ cwd: workspace, objective: "contract fixture" });
    expect(() => RunEnvelopeSchema.parse(envelope)).not.toThrow();
    expect(envelope.packageIdentity.packageName).toBe("pi-codex-habitat-harness");
  });

  it("runs DDF review/rank/cluster fixtures without mutating patch truth", async () => {
    const status = ddfStatus(workspace);
    if (!status.binary || status.engineState === "unavailable") {
      console.warn("deep-diff-forge unavailable; skipping live fixture assertions");
      return;
    }
    const patch = await readFile("fixtures/deep-diff-forge/simple.patch", "utf8");
    const review = reviewPatch(workspace, patch, "review");
    const rank = reviewPatch(workspace, patch, "rank");
    const cluster = reviewPatch(workspace, patch, "cluster");
    expect(review.exitCode).toBe(0);
    expect(rank.exitCode).toBe(0);
    expect(cluster.exitCode).toBe(0);
    expect(review.schema).toBe("deep-diff-forge.review.v0");
    expect(rank.schema).toBe("deep-diff-forge.rank.v0");
    expect(cluster.schema).toBe("deep-diff-forge.cluster.v0");
    expect(review.patchTruthPreserved).toBe(true);
    expect(existsSync(status.binary)).toBe(true);
  });

  it("captures malformed DDF patch as typed review failure", async () => {
    const status = ddfStatus(workspace);
    if (!status.binary || status.engineState === "unavailable") return;
    const patch = await readFile("fixtures/deep-diff-forge/malformed.patch", "utf8");
    const result = reviewPatch(workspace, patch, "review");
    expect(result.exitCode).toBe(4);
    expect(result.typedFailure).toBe("parse_failure");
    expect(result.patchTruthPreserved).toBe(true);
  });
});
