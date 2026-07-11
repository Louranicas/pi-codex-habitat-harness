import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { actorBridgeStatus } from "../extensions/actor-bridges.js";
import { appendReceipt, redactSecrets, verifyReceiptLedger, writeJsonArtifact } from "../extensions/codex-receipts.js";
import { classifyPermission } from "../extensions/codex-safety-membrane.js";
import { circulateReceiptToPovm } from "../extensions/external-circulation.js";
import { ddfStatus, reviewPatch, writeDdfArtifact, type DdfMode } from "../extensions/deep-diff-forge-review.js";
import { observeHabitat } from "../extensions/habitat-observation.js";
import { checkPackageIdentity } from "../extensions/package-identity.js";
import { createBaseEnvelope } from "../extensions/run-envelope.js";
import { harnessStatus } from "../extensions/status.js";
import { observeWriteCapacity, scopedWrite } from "../extensions/write-capacity.js";

type CheckStatus = "pass" | "fail" | "warn";

interface ArenaCheck {
  name: string;
  status: CheckStatus;
  detail: unknown;
}

interface ArenaReport {
  schema: "codex-pi-harness.arena.v0";
  runId: string;
  startedAt: string;
  finishedAt: string;
  workspaceCwd: string;
  packageRoot: string;
  summary: {
    verdict: "pass" | "fail";
    pass: number;
    warn: number;
    fail: number;
    hardStopsPreserved: boolean;
    deployPushShipArmed: false;
  };
  checks: ArenaCheck[];
  artifacts: Array<{ path: string; sha256?: string }>;
  receipt: { path: string; eventHash: string; verified: boolean } | null;
}

const startedAt = new Date().toISOString();
const workspaceCwd = resolve(process.argv[2] ?? "..");
const packageRoot = process.cwd();
const runId = `arena-${Date.now()}`;
const checks: ArenaCheck[] = [];
const artifacts: Array<{ path: string; sha256?: string }> = [];

function record(name: string, status: CheckStatus, detail: unknown): void {
  checks.push({ name, status, detail });
  const icon = status === "pass" ? "PASS" : status === "warn" ? "WARN" : "FAIL";
  console.log(`[${icon}] ${name}`);
}

function expectCheck(name: string, condition: boolean, detail: unknown): void {
  record(name, condition ? "pass" : "fail", detail);
}

async function main(): Promise<void> {
  const identity = await checkPackageIdentity(workspaceCwd);
  expectCheck("package identity canonical", identity.ok, identity);

  const habitat = await observeHabitat(workspaceCwd);
  expectCheck("SYNTHEX v2 thermal observed at :8092/v3/thermal", habitat.liveServices.some((service) => service.name === "SYNTHEX v2 Thermal" && service.portOrTransport === "tcp:8092" && service.healthPath === "/v3/thermal" && service.probeState === "healthy"), habitat.liveServices.filter((service) => service.name.includes("SYNTHEX")));

  const writeCapacity = observeWriteCapacity(workspaceCwd);
  expectCheck("write capacity enabled package-scoped", writeCapacity.enabled && writeCapacity.hardStopsPreserved, writeCapacity);

  const writePayload = JSON.stringify({ schema: "codex-pi-harness.arena-write-proof.v0", runId, ok: true, startedAt }, null, 2) + "\n";
  const writeProof = await scopedWrite({ cwd: workspaceCwd, relativePath: `.pi/codex-harness/arena/${runId}/scoped-write-proof.json`, content: writePayload, confirmWrite: true });
  artifacts.push({ path: writeProof.path, sha256: writeProof.sha256 });
  expectCheck("scoped write read-back verified", writeProof.verified && writeProof.receipt.verified, writeProof);

  const blockedWriteResults = await Promise.allSettled([
    scopedWrite({ cwd: workspaceCwd, relativePath: "../arena-escape.txt", content: "no\n", confirmWrite: true }),
    scopedWrite({ cwd: workspaceCwd, relativePath: "package-lock.json", content: "no\n", confirmWrite: true }),
    scopedWrite({ cwd: workspaceCwd, relativePath: ".git/config", content: "no\n", confirmWrite: true }),
  ]);
  expectCheck("unsafe scoped writes refused", blockedWriteResults.every((result) => result.status === "rejected"), blockedWriteResults.map((result) => result.status));

  const safetyCases = [
    classifyPermission({ cwd: workspaceCwd, objective: "read status", command: "npm run status -- ..", declaredPermissions: ["read"] }),
    classifyPermission({ cwd: workspaceCwd, objective: "deploy release", command: "git push && deploy release", declaredPermissions: ["write"] }),
    classifyPermission({ cwd: workspaceCwd, objective: "fabric server", command: "fabric --serve" }),
    classifyPermission({ cwd: workspaceCwd, objective: "ddf daemon", command: "deep-diff-forge daemon start" }),
  ];
  expectCheck(
    "safety membrane classifies read, armed, and hard-stop routes",
    safetyCases[0]?.class === "AUTO" && safetyCases[1]?.class === "GATE" && safetyCases.slice(2).every((item) => item.class === "BLOCK"),
    safetyCases,
  );

  const redacted = redactSecrets({ OPENAI_API_KEY: "sk-arena-secret-value-123456", nested: { authorization: "Bearer arena-token-1234567890" } });
  expectCheck("secret redaction active", JSON.stringify(redacted).includes("[REDACTED]") && !JSON.stringify(redacted).includes("sk-arena-secret"), redacted);

  const actors = actorBridgeStatus(workspaceCwd);
  expectCheck("actor bridges live-ready or fixture-ready without live overclaim", [actors.codexSdk, actors.agentsTs, actors.agentsPy].every((actor) => actor.liveCallState !== "passed" && ["live_ready", "offline_fixture_ready", "auth_missing"].includes(actor.state)), actors);

  const ddf = ddfStatus(workspaceCwd);
  expectCheck("DDF engine available", ddf.engineState !== "unavailable" && ddf.selfTestOk, ddf);
  const patch = readFileSync(join(packageRoot, "fixtures", "deep-diff-forge", "simple.patch"), "utf8");
  const ddfResults = Object.fromEntries(([
    "review",
    "rank",
    "cluster",
  ] as DdfMode[]).map((mode) => [mode, reviewPatch(workspaceCwd, patch, mode)]));
  const ddfArtifactResults = [];
  for (const result of Object.values(ddfResults)) ddfArtifactResults.push(await writeDdfArtifact(workspaceCwd, result));
  artifacts.push(...ddfArtifactResults);
  expectCheck("DDF review/rank/cluster schemas pass", ddfResults.review?.schema === "deep-diff-forge.review.v0" && ddfResults.rank?.schema === "deep-diff-forge.rank.v0" && ddfResults.cluster?.schema === "deep-diff-forge.cluster.v0" && Object.values(ddfResults).every((result) => result.patchTruthPreserved), ddfResults);
  const malformed = reviewPatch(workspaceCwd, readFileSync(join(packageRoot, "fixtures", "deep-diff-forge", "malformed.patch"), "utf8"), "review");
  expectCheck("DDF malformed patch typed failure", malformed.exitCode === 4 && malformed.typedFailure === "parse_failure" && malformed.patchTruthPreserved, malformed);

  const ledger = await verifyReceiptLedger(workspaceCwd);
  expectCheck("receipt ledger verifies", ledger.ok, ledger);

  const reportDraft: ArenaReport = {
    schema: "codex-pi-harness.arena.v0",
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    workspaceCwd,
    packageRoot,
    summary: summarize(null),
    checks,
    artifacts,
    receipt: null,
  };
  reportDraft.summary = summarize(reportDraft);
  const reportPath = join(packageRoot, ".pi", "codex-harness", "arena", runId, "report.json");
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(reportDraft, null, 2) + "\n", "utf8");
  artifacts.push({ path: reportPath });

  const reportArtifact = await writeJsonArtifact(workspaceCwd, `arena/${runId}/report-artifact.json`, reportDraft);
  artifacts.push(reportArtifact);
  const envelope = createBaseEnvelope({
    cwd: workspaceCwd,
    objective: `Full featureset capacity arena ${runId}`,
    kind: "factory_route",
    verdict: reportDraft.summary.verdict,
    safety: {
      class: "DEFER",
      reason: "arena writes are package-scoped/local artifacts only; deploy/push/ship/factory authorization remain blocked",
      declaredPermissions: ["read", "local_file_write", "package_scoped_write"],
      observedEffects: artifacts.map((artifact) => relative(workspaceCwd, artifact.path)),
      permissionDelta: "expected",
    },
  });
  envelope.substrateClass = "habitat_observed";
  envelope.receiptCirculationClass = "local_file";
  envelope.zellij = habitat.zellij;
  envelope.liveServices = habitat.liveServices;
  envelope.looms = habitat.looms;
  envelope.justfile = habitat.justfile;
  envelope.runbook = habitat.runbook;
  envelope.fabric = habitat.fabric;
  envelope.deepDiffForge = habitat.deepDiffForge;
  envelope.artifacts.push(...artifacts);
  const receipt = await appendReceipt(workspaceCwd, envelope);
  let finalReceipt = receipt;
  const povmAck = await circulateReceiptToPovm(receipt.eventHash, habitat);
  const povmAckArtifact = await writeJsonArtifact(workspaceCwd, `arena/${runId}/povm-ack.json`, povmAck);
  artifacts.push(povmAckArtifact);
  expectCheck("POVM receipt circulation ACK", povmAck.ok, povmAck);
  if (povmAck.ok) {
    const ackEnvelope = createBaseEnvelope({
      cwd: workspaceCwd,
      objective: `Full featureset capacity arena external ACK ${runId}`,
      kind: "factory_route",
      verdict: "pass",
      safety: {
        class: "AUTO",
        reason: "external POVM ACK of arena receipt; no deploy/push/ship/factory authorization",
        declaredPermissions: ["read", "local_file_write", "povm_memory_write"],
        observedEffects: [relative(workspaceCwd, povmAckArtifact.path), povmAck.id ?? "povm_ack_missing"],
        permissionDelta: "expected",
      },
    });
    ackEnvelope.substrateClass = "habitat_observed";
    ackEnvelope.receiptCirculationClass = "habitat_observed";
    ackEnvelope.zellij = habitat.zellij;
    ackEnvelope.liveServices = habitat.liveServices;
    ackEnvelope.looms = habitat.looms;
    ackEnvelope.justfile = habitat.justfile;
    ackEnvelope.runbook = habitat.runbook;
    ackEnvelope.fabric = habitat.fabric;
    ackEnvelope.deepDiffForge = habitat.deepDiffForge;
    ackEnvelope.artifacts.push(povmAckArtifact);
    ackEnvelope.receipts.push({ path: receipt.path, id: receipt.eventHash });
    finalReceipt = await appendReceipt(workspaceCwd, ackEnvelope);
  }
  const finalStatus = await harnessStatus(workspaceCwd);
  const promotedGates = ["GATE-08", "GATE-14", "GATE-18", "GATE-19", "GATE-20"];
  expectCheck("status ready_full_read_write_capacity", finalStatus.status === "ready_full_read_write_capacity", { status: finalStatus.status, s1008820: finalStatus.s1008820, receiptCirculationClass: finalStatus.receiptCirculationClass });
  expectCheck("deploy/push/ship hard stops preserved", finalStatus.hardStops.noDeployPushShip && finalStatus.hardStops.noFactoryAuthorizeWrite && finalStatus.hardStops.noDdfDaemonStart && finalStatus.hardStops.noFabricServer && finalStatus.s1008820.deployPushShipArmed === false, finalStatus.hardStops);
  expectCheck("capacity gates 08/14/18/19/20 pass", promotedGates.every((gate) => finalStatus.habitat.gates[gate] === "pass"), finalStatus.habitat.gates);
  reportDraft.receipt = { path: finalReceipt.path, eventHash: finalReceipt.eventHash, verified: finalReceipt.verified };
  reportDraft.finishedAt = new Date().toISOString();
  reportDraft.summary = summarize(reportDraft);
  await writeFile(reportPath, JSON.stringify(reportDraft, null, 2) + "\n", "utf8");

  console.log(JSON.stringify({ verdict: reportDraft.summary.verdict, summary: reportDraft.summary, reportPath, receipt: reportDraft.receipt }, null, 2));
  if (reportDraft.summary.verdict !== "pass") process.exitCode = 1;
}

function summarize(_report: ArenaReport | null): ArenaReport["summary"] {
  const pass = checks.filter((check) => check.status === "pass").length;
  const warn = checks.filter((check) => check.status === "warn").length;
  const fail = checks.filter((check) => check.status === "fail").length;
  return { verdict: fail === 0 ? "pass" : "fail", pass, warn, fail, hardStopsPreserved: true, deployPushShipArmed: false };
}

main().catch((error: unknown) => {
  record("arena unhandled exception", "fail", error instanceof Error ? { message: error.message, stack: error.stack } : error);
  console.error(error);
  process.exitCode = 1;
});
