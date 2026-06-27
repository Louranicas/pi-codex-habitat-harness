import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { PACKAGE_IDENTITY, RUN_ENVELOPE_SCHEMA } from "./constants.js";

export const AuthState = z.enum(["present", "missing", "invalid", "not_required"]);
export const LiveCallState = z.enum(["not_required", "skipped", "attempted", "passed", "failed"]);
export const SubstrateClass = z.enum(["local_only", "habitat_observed", "factory_integrated", "factory_armed"]);
export const ReceiptCirculationClass = z.enum(["local_file", "habitat_observed", "factory_integrated"]);
export const Verdict = z.enum(["pass", "fail", "partial", "skipped", "unknown"]);

export const RunEnvelopeSchema = z.object({
  schema: z.literal(RUN_ENVELOPE_SCHEMA),
  runId: z.string().min(1),
  kind: z.enum(["codex_thread", "agents_ts_workflow", "agents_py_workflow", "morphogenic_loop", "factory_route", "review"]),
  packageIdentity: z.object({
    packageName: z.literal(PACKAGE_IDENTITY.packageName),
    packageRoot: z.literal(PACKAGE_IDENTITY.packageRoot),
    receiptNamespace: z.literal(PACKAGE_IDENTITY.receiptNamespace),
  }),
  cwd: z.string().min(1),
  objectiveHash: z.string().min(1),
  authState: AuthState,
  liveCallState: LiveCallState,
  substrateClass: SubstrateClass,
  receiptCirculationClass: ReceiptCirculationClass,
  versions: z.object({
    pi: z.string().optional(),
    node: z.string().optional(),
    codexSdk: z.string().optional(),
    codexCli: z.string().optional(),
    openaiAgentsTs: z.string().optional(),
    openaiAgentsPy: z.string().optional(),
    zod: z.string().optional(),
    zellij: z.string().optional(),
  }),
  zellij: z.object({
    session: z.string().nullable(),
    tabCount: z.number().nullable(),
    paneCount: z.number().nullable(),
    commandSource: z.enum(["zellij_action", "zellij_session_action", "watch", "dump_screen", "plugin_pipe", "not_used"]),
    pluginRefs: z.array(z.string()),
  }),
  liveServices: z.array(z.object({
    name: z.string(),
    portOrTransport: z.string(),
    healthPath: z.string().nullable(),
    vaultAnchor: z.string().nullable(),
    probeState: z.enum(["healthy", "degraded", "down", "unknown", "not_probed"]),
    integrationState: z.enum(["mapped", "observed", "integrated", "degraded", "retired"]),
  })),
  looms: z.object({
    templates: z.array(z.enum(["gate", "probe", "ship"])),
    wrights: z.array(z.enum(["LOOMWRIGHT", "TAILWRIGHT", "SHIPWRIGHT", "factory-conductor"])),
    shipArmed: z.boolean(),
  }),
  justfile: z.object({
    version: z.string().nullable(),
    dumpJsonOk: z.boolean(),
    fmtCheckOk: z.boolean().nullable(),
    recipe: z.string().nullable(),
    recipeClass: z.enum(["observe", "quality", "diagnostics", "ops", "mutating", "armed", "unknown", "not_used"]),
  }),
  runbook: z.object({
    path: z.string().nullable(),
    authorityClass: z.enum(["local", "dry_run", "read_only", "mutating", "armed", "emergency", "unknown", "not_used"]),
    verificationState: z.enum(["not_required", "pending", "verified", "failed", "awaiting_human"]),
  }),
  fabric: z.object({
    version: z.string().nullable(),
    pattern: z.string().nullable(),
    patternClass: z.enum(["read_only", "dry_run", "network_ingest", "code_writing", "file_mutating", "server", "unknown", "not_used"]),
    dryRun: z.boolean(),
  }),
  deepDiffForge: z.object({
    version: z.string().nullable(),
    engineState: z.enum(["available_clean", "available_dirty", "unavailable", "not_used"]),
    reviewSchema: z.string().nullable(),
    riskSummary: z.string().nullable(),
    patchTruthPreserved: z.boolean(),
  }),
  safety: z.object({
    class: z.enum(["AUTO", "DEFER", "GATE", "BLOCK"]),
    reason: z.string(),
    declaredPermissions: z.array(z.string()),
    observedEffects: z.array(z.string()),
    permissionDelta: z.enum(["none", "expected", "violation", "unknown"]),
  }),
  artifacts: z.array(z.object({ path: z.string(), sha256: z.string().optional() })),
  receipts: z.array(z.object({ path: z.string(), id: z.string().optional(), sha256: z.string().optional() })),
  morphogenic: z.object({
    morphIrId: z.string().nullable(),
    cwrRunGraph: z.string().nullable(),
    ceeFitnessScalar: z.number().nullable(),
    ceeVerdict: z.enum(["passed", "failed", "not_evaluable", "degraded_refuter", "not_run"]),
  }),
  dissentHealth: z.enum(["healthy", "dark", "unknown", "not_required"]),
  skillUsed: z.enum(["none", "auto", "forced"]),
  prevHash: z.string().nullable(),
  eventHash: z.string().min(1),
  verdict: Verdict,
}).superRefine((value, ctx) => {
  if (value.authState === "missing" && value.liveCallState === "passed") {
    ctx.addIssue({ code: "custom", path: ["liveCallState"], message: "missing auth cannot count as live success" });
  }
  if (value.substrateClass === "factory_armed" && value.receiptCirculationClass !== "factory_integrated") {
    ctx.addIssue({ code: "custom", path: ["receiptCirculationClass"], message: "factory_armed requires factory_integrated receipt circulation" });
  }
});

export type RunEnvelope = z.infer<typeof RunEnvelopeSchema>;

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, inner]) => [key, sortKeys(inner)]),
    );
  }
  return value;
}

export function objectiveHash(objective: string): string {
  return sha256(objective);
}

export interface BaseEnvelopeInput {
  cwd: string;
  objective: string;
  kind?: RunEnvelope["kind"];
  authState?: RunEnvelope["authState"];
  liveCallState?: RunEnvelope["liveCallState"];
  verdict?: RunEnvelope["verdict"];
  safety?: Partial<RunEnvelope["safety"]>;
}

export function createBaseEnvelope(input: BaseEnvelopeInput): RunEnvelope {
  return {
    schema: RUN_ENVELOPE_SCHEMA,
    runId: randomUUID(),
    kind: input.kind ?? "review",
    packageIdentity: PACKAGE_IDENTITY,
    cwd: input.cwd,
    objectiveHash: objectiveHash(input.objective),
    authState: input.authState ?? "not_required",
    liveCallState: input.liveCallState ?? "not_required",
    substrateClass: "local_only",
    receiptCirculationClass: "local_file",
    versions: { node: process.version },
    zellij: { session: null, tabCount: null, paneCount: null, commandSource: "not_used", pluginRefs: [] },
    liveServices: [],
    looms: { templates: [], wrights: [], shipArmed: false },
    justfile: { version: null, dumpJsonOk: false, fmtCheckOk: null, recipe: null, recipeClass: "not_used" },
    runbook: { path: null, authorityClass: "not_used", verificationState: "not_required" },
    fabric: { version: null, pattern: null, patternClass: "not_used", dryRun: false },
    deepDiffForge: { version: null, engineState: "not_used", reviewSchema: null, riskSummary: null, patchTruthPreserved: true },
    safety: {
      class: input.safety?.class ?? "AUTO",
      reason: input.safety?.reason ?? "offline/local receipt event",
      declaredPermissions: input.safety?.declaredPermissions ?? [],
      observedEffects: input.safety?.observedEffects ?? [],
      permissionDelta: input.safety?.permissionDelta ?? "none",
    },
    artifacts: [],
    receipts: [],
    morphogenic: { morphIrId: null, cwrRunGraph: null, ceeFitnessScalar: null, ceeVerdict: "not_run" },
    dissentHealth: "unknown",
    skillUsed: "none",
    prevHash: null,
    eventHash: "pending",
    verdict: input.verdict ?? "unknown",
  };
}

export function finalizeEnvelopeHash(envelope: RunEnvelope, prevHash: string | null): RunEnvelope {
  const next = { ...envelope, prevHash, eventHash: "pending" } satisfies RunEnvelope;
  const eventHash = sha256(stableJson(next));
  const finalized = { ...next, eventHash } satisfies RunEnvelope;
  return RunEnvelopeSchema.parse(finalized);
}
