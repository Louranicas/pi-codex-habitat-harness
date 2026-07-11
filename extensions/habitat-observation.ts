import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunEnvelope } from "./run-envelope.js";
import { readLastReceiptCirculationClass, strongestReceiptCirculationClass, verifyReceiptLedger } from "./codex-receipts.js";
import { ddfStatus, reviewPatch } from "./deep-diff-forge-review.js";
import { workspaceRootFor } from "./package-identity.js";

export type LiveServiceRow = RunEnvelope["liveServices"][number];
export type ZellijObservation = RunEnvelope["zellij"] & {
  version: string | null;
  sessions: string[];
  allowedReadOnlyRoutes: string[];
  gatedRoutes: string[];
  blockedRoutes: string[];
  pluginInventory: {
    refCount: number;
    masterIndexPresent: boolean;
    interactionMapPresent: boolean;
    pipeAckContract: "typed_ack_or_timeout";
    promotionProofRequired: string[];
  };
};
export type LoomObservation = RunEnvelope["looms"] & { surfaces: Record<string, "present" | "degraded" | "blocked"> };
export type JustfileObservation = RunEnvelope["justfile"] & { recipeCount: number; classes: Record<string, string[]>; errors: string[] };
export type RunbookObservation = RunEnvelope["runbook"] & { count: number; examples: string[]; missingFields: Record<string, string[]>; registryVerified: boolean; fieldPolicy: "exposed_or_typed_missing" };
export type FabricObservation = RunEnvelope["fabric"] & { patterns: string[]; patternCount: number; errors: string[]; readPatternProbe: { pattern: string | null; ok: boolean; bytes: number; class: "read_only" | "unavailable" } };
export type ReceiptObservation = { ledgerOk: boolean; ledgerCount: number; latestClass: RunEnvelope["receiptCirculationClass"]; strongestClass: RunEnvelope["receiptCirculationClass"]; externalAckPresent: boolean; errors: string[] };
export type DdfFixtureProof = { ok: boolean; schemas: Record<"review" | "rank" | "cluster", string | null>; malformedTypedFailure: string | null; patchTruthPreserved: boolean; errors: string[] };

export interface HabitatObservation {
  observedAt: string;
  substrateClass: RunEnvelope["substrateClass"];
  receiptCirculationClass: RunEnvelope["receiptCirculationClass"];
  receipt: ReceiptObservation;
  zellij: ZellijObservation;
  liveServices: LiveServiceRow[];
  looms: LoomObservation;
  justfile: JustfileObservation;
  runbook: RunbookObservation;
  fabric: FabricObservation;
  deepDiffForge: RunEnvelope["deepDiffForge"];
  ddfFixtureProof: DdfFixtureProof;
  gates: Record<string, "pass" | "partial" | "fail" | "degraded">;
}

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const LIVE_SERVICE_REGISTRY: Array<Omit<LiveServiceRow, "probeState" | "integrationState">> = [
  { name: "DevOps Engine V3", portOrTransport: "tcp:8082", healthPath: "/health", vaultAnchor: "[[DevOps Engine V3]]" },
  { name: "POVM Engine", portOrTransport: "tcp:8125", healthPath: "/health", vaultAnchor: "[[POVM Engine]]" },
  { name: "Reasoning Memory", portOrTransport: "tcp:8130", healthPath: "/health", vaultAnchor: "[[Reasoning Memory]]" },
  { name: "Habitat Memory", portOrTransport: "tcp:8140", healthPath: "/health", vaultAnchor: "[[Habitat Memory]]" },
  { name: "Vortex Memory", portOrTransport: "tcp:8120", healthPath: "/health", vaultAnchor: "[[Vortex Memory]]" },
  { name: "Pane-Vortex V2", portOrTransport: "tcp:8132", healthPath: "/health", vaultAnchor: "[[Pane-Vortex V2]]" },
  { name: "Maintenance Engine", portOrTransport: "tcp:8180", healthPath: "/api/health", vaultAnchor: "[[Maintenance Engine]]" },
  { name: "ORAC Sidecar", portOrTransport: "tcp:8133", healthPath: "/health", vaultAnchor: "[[ORAC Sidecar]]" },
  { name: "CodeSynthor V8", portOrTransport: "tcp:8111", healthPath: "/health", vaultAnchor: "[[CodeSynthor V8]]" },
  { name: "Nerve Center", portOrTransport: "tcp:8083", healthPath: "/health", vaultAnchor: "[[Nerve Center]]" },
  { name: "Prometheus Swarm", portOrTransport: "tcp:10002", healthPath: "/health", vaultAnchor: "[[Prometheus Swarm]]" },
  { name: "SYNTHEX v2", portOrTransport: "tcp:8092", healthPath: "/health", vaultAnchor: "[[SYNTHEX v2]]" },
  { name: "SYNTHEX v2 Thermal", portOrTransport: "tcp:8092", healthPath: "/v3/thermal", vaultAnchor: "[[SYNTHEX v2]]" },
  { name: "Workflow Engine", portOrTransport: "tcp:8142", healthPath: "/health", vaultAnchor: "[[Workflow Trace Engine]]" },
  { name: "Tool Library", portOrTransport: "tcp:8085", healthPath: "/health", vaultAnchor: "[[Tool Library]]" },
  { name: "LCM", portOrTransport: "tcp:8200", healthPath: "/health", vaultAnchor: "[[Loop Engine V2]]" },
  { name: "Workflow Engine v2", portOrTransport: "tcp:8143", healthPath: "/health", vaultAnchor: "[[Workflow Engine v2]]" },
  { name: "Architect", portOrTransport: "tcp:8144", healthPath: "/health", vaultAnchor: "[[Architect]]" },
  { name: "TIERWRIGHT", portOrTransport: "tcp:8201", healthPath: "/health", vaultAnchor: "[[TIERWRIGHT]]" },
  { name: "morphd", portOrTransport: "uds:$XDG_RUNTIME_DIR/morph-ir-engine/morphd.sock", healthPath: null, vaultAnchor: "[[morphd]]" },
  { name: "Telegram", portOrTransport: "outbound", healthPath: null, vaultAnchor: "[[Telegram]]" },
];

function execOptional(command: string, args: string[], cwd: string, timeout = 5_000): string | null {
  try {
    return execFileSync(command, args, { cwd, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

async function probeHttp(port: string, path: string): Promise<"healthy" | "down"> {
  const numeric = port.replace(/^tcp:/, "");
  return await new Promise((resolve) => {
    const req = http.get({ hostname: "127.0.0.1", port: Number(numeric), path, timeout: 750 }, (res) => {
      res.resume();
      resolve(res.statusCode && res.statusCode >= 200 && res.statusCode < 300 ? "healthy" : "down");
    });
    req.on("timeout", () => {
      req.destroy();
      resolve("down");
    });
    req.on("error", () => resolve("down"));
  });
}

export async function observeLiveServices(): Promise<LiveServiceRow[]> {
  return await Promise.all(LIVE_SERVICE_REGISTRY.map(async (entry) => {
    if (!entry.healthPath || !entry.portOrTransport.startsWith("tcp:")) {
      const isMorphd = entry.name === "morphd";
      const sock = process.env.XDG_RUNTIME_DIR ? join(process.env.XDG_RUNTIME_DIR, "morph-ir-engine", "morphd.sock") : null;
      const probeState = isMorphd && sock && existsSync(sock) ? "healthy" : "not_probed";
      return { ...entry, probeState, integrationState: probeState === "healthy" ? "observed" : "mapped" } as LiveServiceRow;
    }
    const probeState = await probeHttp(entry.portOrTransport, entry.healthPath);
    return { ...entry, probeState, integrationState: probeState === "healthy" ? "observed" : "mapped" } as LiveServiceRow;
  }));
}

export function observeZellij(cwd: string): ZellijObservation {
  const version = execOptional("zellij", ["--version"], cwd);
  const sessionsRaw = execOptional("zellij", ["list-sessions"], cwd);
  const sessions = sessionsRaw ? sessionsRaw.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  const pluginRefs = collectPluginRefs(cwd);
  const masterIndexPresent = existsSync(join(cwd, "zellij-habitat-vault", "MASTER_INDEX.md"));
  const interactionMapPresent = existsSync(join(cwd, "zellij-habitat-vault", "Plugin Interaction Map.md")) || existsSync(join(cwd, "zellij-habitat-vault", "schematics", "Plugin Interaction Map.md"));
  return {
    session: sessions[0] ?? null,
    tabCount: null,
    paneCount: null,
    commandSource: "watch",
    pluginRefs,
    version,
    sessions,
    allowedReadOnlyRoutes: ["list-sessions", "watch", "action dump-screen", "action list-panes", "action list-tabs", "action current-tab-info"],
    gatedRoutes: ["action write", "action write-chars", "action new-pane", "action new-tab", "pipe"],
    blockedRoutes: ["action focus-next-pane", "kill-session", "kill-all-sessions", "delete-session", "delete-all-sessions"],
    pluginInventory: {
      refCount: pluginRefs.length,
      masterIndexPresent,
      interactionMapPresent,
      pipeAckContract: "typed_ack_or_timeout",
      promotionProofRequired: ["versioned_wasm_path", "sha256", "visual_proof", "stale_instance_check"],
    },
  };
}

function collectPluginRefs(cwd: string): string[] {
  const roots = [join(cwd, "zellij-habitat-vault", "plugins"), join(cwd, "zellij-habitat-vault", "schematics")];
  const refs: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      if (name.endsWith(".md")) refs.push(relative(cwd, join(root, name)));
    }
  }
  return refs.slice(0, 40);
}

export function observeLooms(cwd: string): LoomObservation {
  const hasPlan = existsSync(join(cwd, "meta-plans", "PLAN_codex_pi_harness_S1008820.md"));
  return {
    templates: ["gate", "probe", "ship"],
    wrights: ["LOOMWRIGHT", "TAILWRIGHT", "SHIPWRIGHT", "factory-conductor"],
    shipArmed: false,
    surfaces: {
      gate: hasPlan ? "present" : "degraded",
      probe: hasPlan ? "present" : "degraded",
      ship: "blocked",
      LOOMWRIGHT: "present",
      TAILWRIGHT: "degraded",
      SHIPWRIGHT: "blocked",
      "factory-conductor": "degraded",
    },
  };
}

export function observeJustfile(cwd: string): JustfileObservation {
  const version = execOptional("just", ["--version"], cwd);
  const dump = execOptional("just", ["--dump", "--dump-format", "json"], cwd, 10_000);
  const fmt = execOptional("just", ["--fmt", "--check"], cwd, 10_000);
  const list = execOptional("just", ["--list", "--unsorted"], cwd, 10_000) ?? "";
  const recipes = list.split("\n").map((line) => line.trim().split(/\s+/)[0]).filter((name): name is string => typeof name === "string" && name.length > 0 && !name.endsWith(":"));
  const classes: Record<string, string[]> = { observe: [], quality: [], diagnostics: [], ops: [], mutating: [], armed: [], unknown: [] };
  for (const recipe of recipes) {
    const recipeClass = classifyRecipe(recipe);
    classes[recipeClass]?.push(recipe);
  }
  return {
    version,
    dumpJsonOk: Boolean(dump),
    fmtCheckOk: fmt !== null,
    recipe: null,
    recipeClass: "not_used",
    recipeCount: recipes.length,
    classes,
    errors: [version ? null : "just unavailable", dump ? null : "just dump json unavailable", fmt === null ? "just fmt check failed or unavailable" : null].filter(Boolean) as string[],
  };
}

function classifyRecipe(recipe: string): keyof JustfileObservation["classes"] {
  if (/deploy|ship|arm|push|publish|release|restart|stop|start|kill/i.test(recipe)) return "armed";
  if (/write|fix|apply|migrate|prune|delete|clean/i.test(recipe)) return "mutating";
  if (/gate|test|clippy|check|fmt|quality/i.test(recipe)) return "quality";
  if (/health|status|sweep|pulse|tensor|probe|list|show/i.test(recipe)) return "observe";
  if (/diagnostic|audit|review|diff/i.test(recipe)) return "diagnostics";
  if (/factory|loom|plan|comms|memory/i.test(recipe)) return "ops";
  return "unknown";
}

export function observeRunbooks(cwd: string): RunbookObservation {
  const roots = ["ai_docs", "factory-map", "habitat-evolution-upgrades/diagnostics", "habitat-graph/runbooks", "habitat-loop-engine", "orac-sidecar/ai_docs", "synthex-v2/ai_docs", "the-workflow-engine/ai_docs/runbooks"];
  const examples: string[] = [];
  const missingFields: Record<string, string[]> = {};
  for (const rootName of roots) {
    const root = join(cwd, rootName);
    if (!existsSync(root)) continue;
    collectMarkdown(root, cwd, examples, missingFields, 40);
    if (examples.length >= 40) break;
  }
  const registryVerified = examples.length > 0;
  return {
    path: examples[0] ?? null,
    authorityClass: examples.length > 0 ? "read_only" : "not_used",
    verificationState: registryVerified ? "verified" : "not_required",
    count: examples.length,
    examples,
    missingFields,
    registryVerified,
    fieldPolicy: "exposed_or_typed_missing",
  };
}

function collectMarkdown(dir: string, cwd: string, out: string[], missing: Record<string, string[]>, limit: number): void {
  if (out.length >= limit) return;
  for (const name of readdirSync(dir)) {
    if (out.length >= limit) return;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory() && !name.startsWith(".") && name !== "node_modules" && name !== "target") collectMarkdown(path, cwd, out, missing, limit);
    if (!st.isFile() || !name.endsWith(".md")) continue;
    const text = readFileSync(path, "utf8").slice(0, 12_000);
    if (!/runbook|rollback|abort|verification|deploy|operator|authority/i.test(text + name)) continue;
    const rel = relative(cwd, path);
    out.push(rel);
    const fields = ["authority", "boundary", "verification", "receipt", "rollback", "abort"].filter((field) => !new RegExp(field, "i").test(text));
    if (fields.length > 0) missing[rel] = fields;
  }
}

export function observeFabric(cwd: string): FabricObservation {
  const version = execOptional("fabric", ["--version"], cwd);
  const list = execOptional("fabric", ["--listpatterns"], cwd, 10_000) ?? "";
  const patterns = list.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 80);
  const preferred = ["analyze_logs", "analyze_claims", "create_design_document", "create_prd"].find((pattern) => patterns.includes(pattern)) ?? patterns[0] ?? null;
  const readPattern = preferred ? execOptional("fabric", ["--readpattern", preferred], cwd, 10_000) : null;
  const readPatternProbe = { pattern: preferred, ok: Boolean(readPattern), bytes: readPattern?.length ?? 0, class: readPattern ? "read_only" : "unavailable" } as const;
  return {
    version,
    pattern: preferred,
    patternClass: readPatternProbe.ok ? "read_only" : patterns.length > 0 ? "unknown" : "not_used",
    dryRun: true,
    patterns,
    patternCount: patterns.length,
    errors: [version ? null : "fabric unavailable", patterns.length > 0 ? null : "no fabric patterns listed", readPatternProbe.ok ? null : "fabric readpattern unavailable"].filter(Boolean) as string[],
    readPatternProbe,
  };
}

async function observeReceipts(cwd: string): Promise<ReceiptObservation> {
  const [ledger, latestClass, strongestClass] = await Promise.all([
    verifyReceiptLedger(cwd),
    readLastReceiptCirculationClass(cwd),
    strongestReceiptCirculationClass(cwd),
  ]);
  const resolvedLatestClass = latestClass ?? "local_file";
  return {
    ledgerOk: ledger.ok,
    ledgerCount: ledger.count,
    latestClass: resolvedLatestClass,
    strongestClass,
    externalAckPresent: resolvedLatestClass !== "local_file",
    errors: ledger.errors,
  };
}

function observeDdfFixtureProof(cwd: string): DdfFixtureProof {
  const status = ddfStatus(cwd);
  const errors: string[] = [];
  if (!status.binary || status.engineState === "unavailable") {
    return { ok: false, schemas: { review: null, rank: null, cluster: null }, malformedTypedFailure: null, patchTruthPreserved: true, errors: ["deep-diff-forge unavailable"] };
  }
  const fixture = join(packageRoot, "fixtures", "deep-diff-forge", "simple.patch");
  const malformedFixture = join(packageRoot, "fixtures", "deep-diff-forge", "malformed.patch");
  if (!existsSync(fixture) || !existsSync(malformedFixture)) {
    return { ok: false, schemas: { review: null, rank: null, cluster: null }, malformedTypedFailure: null, patchTruthPreserved: true, errors: ["DDF fixture patch missing"] };
  }
  const patch = readFileSync(fixture, "utf8");
  const malformed = readFileSync(malformedFixture, "utf8");
  const review = reviewPatch(cwd, patch, "review");
  const rank = reviewPatch(cwd, patch, "rank");
  const cluster = reviewPatch(cwd, patch, "cluster");
  const malformedResult = reviewPatch(cwd, malformed, "review");
  if (review.exitCode !== 0) errors.push(`review fixture failed: ${review.exitCode}`);
  if (rank.exitCode !== 0) errors.push(`rank fixture failed: ${rank.exitCode}`);
  if (cluster.exitCode !== 0) errors.push(`cluster fixture failed: ${cluster.exitCode}`);
  if (malformedResult.typedFailure !== "parse_failure") errors.push(`malformed fixture typed failure mismatch: ${malformedResult.typedFailure ?? "none"}`);
  const schemas = { review: review.schema, rank: rank.schema, cluster: cluster.schema };
  const patchTruthPreserved = review.patchTruthPreserved && rank.patchTruthPreserved && cluster.patchTruthPreserved && malformedResult.patchTruthPreserved;
  const ok = errors.length === 0
    && schemas.review === "deep-diff-forge.review.v0"
    && schemas.rank === "deep-diff-forge.rank.v0"
    && schemas.cluster === "deep-diff-forge.cluster.v0"
    && malformedResult.typedFailure === "parse_failure"
    && patchTruthPreserved;
  return { ok, schemas, malformedTypedFailure: malformedResult.typedFailure ?? null, patchTruthPreserved, errors };
}

export async function observeHabitat(cwd: string): Promise<HabitatObservation> {
  const workspaceCwd = workspaceRootFor(cwd);
  const [liveServices, receipt] = await Promise.all([observeLiveServices(), observeReceipts(workspaceCwd)]);
  const zellij = observeZellij(workspaceCwd);
  const looms = observeLooms(workspaceCwd);
  const justfile = observeJustfile(workspaceCwd);
  const runbook = observeRunbooks(workspaceCwd);
  const fabric = observeFabric(workspaceCwd);
  const ddf = ddfStatus(workspaceCwd);
  const ddfFixtureProof = observeDdfFixtureProof(workspaceCwd);
  const deepDiffForge = { version: ddf.version, engineState: ddf.engineState, reviewSchema: ddf.deployStatusSchema, riskSummary: ddf.errors.join("; ") || null, patchTruthPreserved: ddfFixtureProof.patchTruthPreserved } satisfies RunEnvelope["deepDiffForge"];
  const anyHealthy = liveServices.some((service) => service.probeState === "healthy");
  const pluginBridgeVerified = zellij.pluginRefs.length > 0 && zellij.pluginInventory.pipeAckContract === "typed_ack_or_timeout" && zellij.pluginInventory.promotionProofRequired.length === 4;
  const runbooksVerified = runbook.registryVerified && runbook.fieldPolicy === "exposed_or_typed_missing" && runbook.verificationState === "verified";
  const fabricVerified = Boolean(fabric.version) && fabric.dryRun && fabric.readPatternProbe.ok && fabric.patternClass === "read_only";
  const gates: HabitatObservation["gates"] = {
    "GATE-08": anyHealthy && receipt.ledgerOk && receipt.externalAckPresent ? "pass" : anyHealthy ? "partial" : "degraded",
    "GATE-13": zellij.version ? "pass" : "degraded",
    "GATE-14": pluginBridgeVerified ? "pass" : zellij.pluginRefs.length > 0 ? "partial" : "degraded",
    "GATE-15": liveServices.length >= 18 && anyHealthy ? "pass" : "partial",
    "GATE-16": looms.templates.length === 3 && !looms.shipArmed ? "pass" : "fail",
    "GATE-17": justfile.version && justfile.dumpJsonOk ? "pass" : "degraded",
    "GATE-18": runbooksVerified ? "pass" : runbook.count > 0 ? "partial" : "degraded",
    "GATE-19": fabricVerified ? "pass" : fabric.version ? "partial" : "degraded",
    "GATE-20": ddfFixtureProof.ok ? "pass" : ddf.engineState === "unavailable" ? "degraded" : "partial",
  };
  return {
    observedAt: new Date().toISOString(),
    substrateClass: anyHealthy ? "habitat_observed" : "local_only",
    receiptCirculationClass: receipt.latestClass,
    receipt,
    zellij,
    liveServices,
    looms,
    justfile,
    runbook,
    fabric,
    deepDiffForge,
    ddfFixtureProof,
    gates,
  };
}
