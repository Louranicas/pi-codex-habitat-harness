import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ThreadItem, ThreadOptions, Usage } from "@openai/codex-sdk";
import { Type } from "typebox";
import { z } from "zod";
import { createTimeoutSignal } from "./abort-timeout.js";
import { appendReceipt, redactSecrets, writeJsonArtifact } from "./codex-receipts.js";
import { buildCodexRuntimeProfile, HARNESS_ZOD_SCHEMAS, type CodexHarnessReasoningEffort } from "./codex-first-class-tools.js";
import { classifyPermission } from "./codex-safety-membrane.js";
import { createCacheBinding, digestSLoomLaneSeal, readSLoomCache, writeSLoomCache, workspaceStateSha, type SLoomCacheMode } from "./s-loom-cache.js";
import { loadSLoomRoster, measureHabitatOperationalRoster, resolveSLoomRole, type ResolvedSLoomRole, type SLoomModule, type SLoomRoster } from "./s-loom-roster.js";
import { resolveWorkspaceDirectory, workspaceRootFor } from "./package-identity.js";
import { createBaseEnvelope } from "./run-envelope.js";
import { scopedWrite } from "./write-capacity.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; details?: unknown };
type PiApi = { registerTool: (definition: Record<string, unknown>) => void };

export type StructuredRun = {
  ok: boolean;
  value?: unknown;
  raw?: string;
  error?: string;
  threadId?: string | null;
  usage?: unknown;
  itemTypes?: string[];
  runtime?: unknown;
  diagnostics?: {
    elapsedMs: number;
    promptChars: number;
    reasoningEffort: CodexHarnessReasoningEffort;
    executionPlane: "codex_sdk" | "codex_sdk_streamed_seal_only";
  };
  attempts?: JudgeAttemptSummary[];
};

type StructuredRunPolicy = {
  label: string;
  forbiddenItemTypes: ReadonlySet<ThreadItem["type"]>;
};

export type JudgeAttemptSummary = {
  attempt: number;
  reasoningEffort: CodexHarnessReasoningEffort;
  timeoutMs: number;
  ok: boolean;
  error: string | null;
  threadId: string | null;
  itemTypes: string[];
  diagnostics: StructuredRun["diagnostics"] | null;
  usage: unknown;
};

type LaneExecution = {
  profile: string;
  moduleId: string;
  roleId: string;
  role: string;
  persona: ReturnType<typeof personaSummary>;
  source: "live" | "smart_cache";
  result: StructuredRun;
  cacheRead: Record<string, unknown>;
};

const LaneResultSchema = z.object({
  role: z.string(),
  finding: z.string(),
  evidence: z.array(z.string()),
  risks: z.array(z.string()),
  recommendation: z.string(),
  confidence: z.number().min(0).max(1),
});

export const JudgeResultSchema = z.object({
  verdict: z.enum(["proceed", "revise", "collapse"]),
  synthesis: z.string().min(1).max(3_000),
  conflicts: z.array(z.string().min(1).max(1_200)).max(8),
  synergies: z.array(z.object({
    modules: z.array(z.string().min(1).max(128)).min(1).max(5),
    mechanism: z.string().min(1).max(1_200),
    expectedImpact: z.string().min(1).max(1_200),
  })).max(8),
  acceptedLaneDigests: z.array(z.string().length(64)).max(5),
  rejectedLaneDigests: z.array(z.string().length(64)).max(5),
  plan: z.array(z.string().min(1).max(1_200)).max(10),
  acceptanceCriteria: z.array(z.string().min(1).max(1_200)).max(10),
});

const VerificationResultSchema = z.object({
  verdict: z.enum(["pass", "fail", "partial"]),
  findings: z.array(z.string()),
  residualRisks: z.array(z.string()),
});

function truncate(text: string, maxChars = 30_000): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]`;
}

function clampText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)} [truncated]`;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function commandVersion(command: string, args: string[], cwd: string): string | null {
  try {
    return execFileSync(command, args, { cwd, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

function loomEarned(objective: string, explicitRoles: string[] | undefined, forceLoom: boolean | undefined): boolean {
  if (forceLoom === true || (explicitRoles?.length ?? 0) >= 3) return true;
  return objective.length >= 120 || /\b(?:architecture|audit|debug|refactor|migration|cross-module|distributed|adversarial|multiple|system)\b/i.test(objective);
}

async function runStructured(
  workingDirectory: string,
  prompt: string,
  schema: z.ZodType,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  accessMode: "read_only" | "workspace_write",
  confirmWorkspaceWrite: boolean,
  modelReasoningEffort: CodexHarnessReasoningEffort,
  policy?: StructuredRunPolicy,
): Promise<StructuredRun> {
  const started = performance.now();
  let runtime: ReturnType<typeof buildCodexRuntimeProfile> | undefined;
  let threadId: string | null = null;
  let itemTypes: string[] = [];
  const diagnostics = (): NonNullable<StructuredRun["diagnostics"]> => ({
    elapsedMs: Math.round((performance.now() - started) * 100) / 100,
    promptChars: prompt.length,
    reasoningEffort: modelReasoningEffort,
    executionPlane: policy ? "codex_sdk_streamed_seal_only" : "codex_sdk",
  });
  try {
    runtime = buildCodexRuntimeProfile(workingDirectory, { accessMode, confirmWorkspaceWrite, modelReasoningEffort });
    const { Codex } = await import("@openai/codex-sdk");
    const codex = new Codex({ config: runtime.clientConfig });
    const thread = codex.startThread(runtime.threadOptions as ThreadOptions);
    const timeout = createTimeoutSignal(signal, timeoutMs);
    let turn: { finalResponse: string; items: ThreadItem[]; usage: Usage | null };
    try {
      if (!policy) {
        turn = await thread.run(prompt, { outputSchema: z.toJSONSchema(schema), signal: timeout.signal });
        threadId = thread.id;
      } else {
        const boundaryAbort = new AbortController();
        const streamed = await thread.runStreamed(prompt, { outputSchema: z.toJSONSchema(schema), signal: AbortSignal.any([timeout.signal, boundaryAbort.signal]) });
        const completedItems = new Map<string, ThreadItem>();
        let finalResponse = "";
        let usage: Usage | null = null;
        for await (const event of streamed.events) {
          if (event.type === "thread.started") threadId = event.thread_id;
          if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
            if (!itemTypes.includes(event.item.type)) itemTypes.push(event.item.type);
            if (policy.forbiddenItemTypes.has(event.item.type)) {
              const error = new Error(`${policy.label} boundary violation: forbidden ${event.item.type} item`);
              boundaryAbort.abort(error);
              throw error;
            }
            if (event.type === "item.completed") {
              completedItems.set(event.item.id, event.item);
              if (event.item.type === "agent_message") finalResponse = event.item.text;
            }
          } else if (event.type === "turn.completed") {
            usage = event.usage;
          } else if (event.type === "turn.failed") {
            throw new Error(event.error.message);
          } else if (event.type === "error") {
            throw new Error(event.message);
          }
        }
        if (!finalResponse) throw new Error(`${policy.label} completed without a final agent message`);
        turn = { finalResponse, items: [...completedItems.values()], usage };
      }
    } catch (error) {
      if (timeout.signal.aborted && timeout.signal.reason instanceof Error) throw timeout.signal.reason;
      throw error;
    } finally {
      timeout.dispose();
    }
    itemTypes = turn.items.map((item) => item.type);
    const parsed = schema.safeParse(JSON.parse(turn.finalResponse));
    if (!parsed.success) return { ok: false, raw: turn.finalResponse, error: parsed.error.message, threadId, usage: turn.usage, itemTypes, runtime, diagnostics: diagnostics() };
    return { ok: true, value: parsed.data, raw: turn.finalResponse, threadId, usage: turn.usage, itemTypes, runtime, diagnostics: diagnostics() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), threadId, itemTypes, runtime, diagnostics: diagnostics() };
  }
}

function parsePersonaSwaps(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("personaSwaps must be an object mapping role keys to persona ids");
  const output: Record<string, string> = {};
  for (const [key, persona] of Object.entries(value)) {
    if (!/^(?:[a-z][a-z0-9-]*\.)?[a-z0-9][a-z0-9-]*$/.test(key)) throw new Error(`invalid persona swap key: ${key}`);
    if (typeof persona !== "string") throw new Error(`personaSwaps.${key} must be a persona id`);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(persona)) throw new Error(`invalid persona id in personaSwaps.${key}: ${persona}`);
    output[key] = persona;
  }
  return output;
}

function requestedPersona(swaps: Record<string, string>, profile: string, roleId: string, lobe: boolean, consumed: Set<string>): string | undefined {
  const qualified = `${profile}.${roleId}`;
  if (lobe && swaps[roleId] !== undefined) throw new Error(`stacked lobe persona swap must be profile-qualified: ${qualified}`);
  if (swaps[qualified] !== undefined && swaps[roleId] !== undefined) throw new Error(`persona swap is shadowed by both ${qualified} and ${roleId}`);
  const key = swaps[qualified] !== undefined ? qualified : !lobe && swaps[roleId] !== undefined ? roleId : null;
  if (!key) return undefined;
  consumed.add(key);
  return swaps[key];
}

function personaSummary(role: ResolvedSLoomRole) {
  return {
    id: role.personaGenome.id,
    rosterRole: role.personaGenome.role,
    geometry: role.personaGenome.routing_bias.preferred_geometry,
    permissionClass: role.personaGenome.permission_envelope.permission_class,
    runtimeEnvelope: "fixed_read_only",
    memoryNamespaces: role.personaGenome.memory_scope.namespaces,
    vetoes: role.personaGenome.collaboration_contract.vetoes,
    swapState: role.swapState,
    genomeSha256: role.personaSha256,
  };
}

function cloneExplicitRole(base: SLoomModule["roles"][number], title: string, index: number): SLoomModule["roles"][number] {
  const id = index < 3 ? base.id : `extension-${index + 1}`;
  return {
    ...base,
    id,
    title,
    mission: `Apply the explicit ${title} lens while preserving the module contract: ${base.mission}`,
    memory: { ...base.memory, namespace: `s-loom/${base.memory.namespace.split("/")[1]}/${id}` },
  };
}

function assertCompatibleStack(roster: SLoomRoster, profiles: string[]): void {
  if (new Set(profiles).size !== profiles.length) throw new Error("stackProfiles must be unique");
  for (const profile of profiles) {
    const module = roster.looms[profile];
    if (!module) throw new Error(`unknown S Loom profile: ${profile}`);
    for (const peer of profiles) {
      if (peer !== profile && !module.compatibleWith.includes(peer)) throw new Error(`S Loom ${profile} is not compatible with ${peer}`);
    }
  }
}

function requireModule(roster: SLoomRoster, profile: string): SLoomModule {
  const module = roster.looms[profile];
  if (!module) throw new Error(`unknown S Loom profile: ${profile}`);
  return module;
}

function requireModuleSha(roster: SLoomRoster, profile: string): string {
  const value = roster.moduleSha256[profile];
  if (!value) throw new Error(`missing S Loom module hash: ${profile}`);
  return value;
}

function resolveExecutionRoles(workspace: string, roster: SLoomRoster, profile: string, explicitRoles: string[] | undefined, stackProfiles: string[] | undefined, swaps: Record<string, string>, earned: boolean): { roles: ResolvedSLoomRole[]; modules: SLoomModule[]; lobe: boolean } {
  const consumedSwaps = new Set<string>();
  if (stackProfiles) {
    assertCompatibleStack(roster, stackProfiles);
    const modules = stackProfiles.map((name) => requireModule(roster, name));
    const roles = modules.map((module) => {
      const role = module.roles.find((candidate) => candidate.id === module.lobeSeat);
      if (!role) throw new Error(`S Loom ${module.profile} lobe seat is missing`);
      return resolveSLoomRole(workspace, module.profile, role, requestedPersona(swaps, module.profile, role.id, true, consumedSwaps));
    });
    const unused = Object.keys(swaps).filter((key) => !consumedSwaps.has(key));
    if (unused.length > 0) throw new Error(`unused persona swap keys: ${unused.join(", ")}`);
    return { roles, modules, lobe: true };
  }

  const module = requireModule(roster, profile);
  const firstRole = module.roles[0];
  if (!firstRole) throw new Error(`S Loom ${profile} has no roles`);
  const selected = earned
    ? explicitRoles?.map((title, index) => cloneExplicitRole(module.roles[index % module.roles.length]!, title, index)) ?? module.roles
    : [{ ...firstRole, id: "direct", title: "direct problem solver", mission: `Solve directly without loom coordination overhead. ${firstRole.mission}`, memory: { ...firstRole.memory, namespace: `s-loom/${profile}/direct` } }];
  const roles = selected.map((role) => resolveSLoomRole(workspace, profile, role, requestedPersona(swaps, profile, role.id, false, consumedSwaps)));
  const unused = Object.keys(swaps).filter((key) => !consumedSwaps.has(key));
  if (unused.length > 0) throw new Error(`unused persona swap keys: ${unused.join(", ")}`);
  return { roles, modules: [module], lobe: false };
}

function collaborationEdges(roles: ResolvedSLoomRole[]) {
  const edges: Array<{ from: string; to: string; mechanism: string }> = [];
  for (let i = 0; i < roles.length; i += 1) {
    for (let j = i + 1; j < roles.length; j += 1) {
      const leftRole = roles[i]!;
      const rightRole = roles[j]!;
      const left = leftRole.personaGenome;
      const right = rightRole.personaGenome;
      const leftToRight = left.collaboration_contract.speaks_to.includes(right.id) || right.collaboration_contract.listens_to.includes(left.id);
      const rightToLeft = right.collaboration_contract.speaks_to.includes(left.id) || left.collaboration_contract.listens_to.includes(right.id);
      if (leftToRight) edges.push({ from: left.id, to: right.id, mechanism: "persona_collaboration_contract_then_seal_bus" });
      if (rightToLeft) edges.push({ from: right.id, to: left.id, mechanism: "persona_collaboration_contract_then_seal_bus" });
      if (!leftToRight && !rightToLeft) edges.push({ from: leftRole.id, to: rightRole.id, mechanism: "interlobe_membrane_via_judge_seal_bus" });
    }
  }
  return edges;
}

export function buildSLobePlan(roster: SLoomRoster, roles: ResolvedSLoomRole[], modules: SLoomModule[], objective: string) {
  const profiles = modules.map((module) => module.profile);
  return {
    schema: "codex-harness.s-lobe-plan.v1",
    id: `s-lobe-${profiles.join("-")}`,
    objective,
    roster: { id: roster.id, version: roster.version, sha256: roster.manifestSha256 },
    sphere: "stacked",
    macro: { campaign: "bounded SOL cognition", owner: "codex_loom_cluster coordinator", judgeBarrier: roster.composition.judgeBarrier, routingDepth: 2, maximumRoutingDepth: roster.composition.maximumRoutingDepth },
    meso: modules.map((module) => ({ profile: module.profile, id: module.id, purpose: module.purpose, ports: module.ports, cacheFamily: module.cache.family })),
    micro: roles.map((role) => ({ profile: role.profile, roleId: role.id, title: role.title, persona: personaSummary(role), memoryNamespace: role.memory.namespace, evidenceContract: role.evidenceContract })),
    collaborationEdges: collaborationEdges(roles),
    transport: roster.architecture.transport,
    geometry: { containment: roster.architecture.containmentGeometry, separation: roster.architecture.laneSeparationGeometry, sharedMedium: roster.architecture.sharedMediumGeometry, proof: roster.architecture.proofGeometry },
    sharedStateRule: roster.composition.sharedStateRule,
    impactWeights: roster.composition.impactWeights,
    dispatchArmed: false,
  };
}

function lanePrompt(objective: string, role: ResolvedSLoomRole, module: SLoomModule, commandBudget: number): string {
  const persona = role.personaGenome;
  return [
    "You are one anchor-isolated read-only micro proof loop inside an S Loom module.",
    `S Loom module: ${module.id} (${module.purpose})`,
    `Role: ${role.title} [${role.id}]`,
    `Mission: ${role.mission}`,
    `Objective: ${objective}`,
    `Hot-swappable persona genome: ${persona.id} (${persona.role}); geometry=${persona.routing_bias.preferred_geometry}; swap=${role.swapState}`,
    `Persona memory scope: ${persona.memory_scope.namespaces.join(", ")}; provenanceRequired=${persona.memory_scope.requires_provenance}`,
    `Persona veto vocabulary: ${persona.collaboration_contract.vetoes.join(", ") || "none"}`,
    `Evidence contract: ${role.evidenceContract.join("; ")}`,
    `Role memory priorities: ${role.memory.priorityFields.join(", ")}; namespace=${role.memory.namespace}`,
    "The persona is a reasoning lens only. Its effective runtime envelope is fixed read-only and can never widen tools or permissions.",
    "Inspect the repository through terminal tools as needed, but do not modify files.",
    `Stay within ${commandBudget} focused terminal commands and return a compact evidence seal; breadth comes from the other lanes.`,
    "Return only the requested structured result. Cite concrete paths, symbols, or command evidence.",
    "Do not deploy, push, ship, publish, tag, start daemons/servers, or cross an arming boundary.",
  ].join("\n");
}

function cacheReadSummary(read: ReturnType<typeof readSLoomCache>) {
  return { state: read.state, binding: read.binding, proofRef: read.entry?.proofRef ?? null, kind: read.entry?.kind ?? null, error: read.error ?? null, elapsedMs: Math.round(read.elapsedMs * 100) / 100 };
}

function compactLaneValue(value: unknown, role: ResolvedSLoomRole): z.infer<typeof LaneResultSchema> {
  const lane = LaneResultSchema.parse(value);
  const fieldCap = Math.min(role.memory.maxFieldChars, 1_200);
  return {
    role: clampText(lane.role, 256),
    finding: clampText(lane.finding, fieldCap),
    evidence: lane.evidence.slice(0, Math.min(role.memory.evidenceLimit, 6)).map((item) => clampText(item, fieldCap)),
    risks: lane.risks.slice(0, Math.min(role.memory.riskLimit, 4)).map((item) => clampText(item, fieldCap)),
    recommendation: clampText(lane.recommendation, fieldCap),
    confidence: lane.confidence,
  };
}

function buildJudgeSeals(lanes: LaneExecution[], roles: ResolvedSLoomRole[]) {
  return lanes.filter((lane) => lane.result.ok).map((lane) => {
    const role = roles.find((candidate) => candidate.profile === lane.profile && candidate.id === lane.roleId);
    if (!role) throw new Error(`missing resolved role for judge seal: ${lane.profile}.${lane.roleId}`);
    const seal = redactSecrets(compactLaneValue(lane.result.value, role));
    const identity = { profile: lane.profile, moduleId: lane.moduleId, roleId: lane.roleId, personaId: lane.persona.id };
    const binding = lane.cacheRead.binding as ReturnType<typeof createCacheBinding> | undefined;
    if (!binding) throw new Error(`missing cache/provenance binding for judge seal: ${lane.profile}.${lane.roleId}`);
    return { ...identity, persona: lane.persona, source: lane.source, digest: digestSLoomLaneSeal(binding, seal), seal };
  });
}

export type JudgeSeal = ReturnType<typeof buildJudgeSeals>[number];
export type SLobePlan = ReturnType<typeof buildSLobePlan>;

const JUDGE_FORBIDDEN_ITEM_TYPES = new Set<ThreadItem["type"]>([
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "web_search",
  "todo_list",
]);

export function buildMacroJudgeContext(plan: SLobePlan) {
  return {
    sphere: plan.sphere,
    macro: plan.macro,
    meso: plan.meso.map((module) => ({
      profile: module.profile,
      id: module.id,
      purpose: module.purpose,
      ports: module.ports,
    })),
    micro: plan.micro.map((role) => ({
      profile: role.profile,
      roleId: role.roleId,
      title: role.title,
      evidenceContract: role.evidenceContract,
    })),
    geometry: plan.geometry,
    sharedStateRule: plan.sharedStateRule,
    impactWeights: plan.impactWeights,
  };
}

export function buildMacroJudgePrompt(objective: string, plan: SLobePlan, judgeSeals: JudgeSeal[], retryReason?: string): string {
  const compactSeals = judgeSeals.map((lane) => ({
    laneKey: `${lane.profile}.${lane.roleId}`,
    profile: lane.profile,
    moduleId: lane.moduleId,
    roleId: lane.roleId,
    personaId: lane.persona.id,
    source: lane.source,
    digest: lane.digest,
    seal: lane.seal,
  }));
  const envelope = JSON.stringify({ context: buildMacroJudgeContext(plan), lanes: compactSeals });
  if (envelope.length > 48_000) throw new Error(`macro judge envelope exceeds 48000 characters: ${envelope.length}`);
  return [
    "You are the outside-context macro judge for an S Loom cognition cluster. You did not author the lane findings.",
    "This is a sealed adjudication transform, not a repository task. The canonical envelope below is the complete evidence boundary.",
    "Do not call terminal, filesystem, web, MCP, planning, todo, or any other tool. Do not inspect the repository or external artifacts.",
    "Your only permitted actions are reasoning over the supplied envelope and one final structured response. Emit no progress, commentary, or draft response.",
    `Objective: ${objective}`,
    `Canonical envelope: ${envelope}`,
    `Impact weights: ${JSON.stringify(plan.impactWeights)}`,
    "Accept a lane only when its seal contains concrete evidence supporting its finding. Reject unsupported or materially contradictory lanes.",
    "Classify every supplied digest exactly once into acceptedLaneDigests or rejectedLaneDigests. Copy digests exactly; never invent or omit one.",
    "Use proceed only with at least two accepted lanes and a coherent evidence-backed plan. Use revise for remediable evidence gaps. Use collapse when coordination adds no value.",
    "Resolve conflicts, identify concrete cross-module synergies, and return a concise converged plan with testable acceptance criteria.",
    "Modules exchange immutable seals and cache references only; never infer shared mutable state or deployment authority.",
    retryReason ? `Retry context: the prior judge attempt was invalid because ${retryReason}. Return the final decision now without tools.` : "",
  ].filter(Boolean).join("\n");
}

export function macroJudgePrimaryBudget(totalTimeoutMs: number): number {
  const bounded = Math.max(1_000, totalTimeoutMs);
  if (bounded < 2_000) return bounded;
  return Math.min(240_000, Math.max(1_000, Math.floor(bounded * 2 / 3)));
}

function summarizeJudgeAttempt(attempt: number, reasoningEffort: CodexHarnessReasoningEffort, timeoutMs: number, result: StructuredRun): JudgeAttemptSummary {
  return {
    attempt,
    reasoningEffort,
    timeoutMs,
    ok: result.ok,
    error: result.error ?? null,
    threadId: result.threadId ?? null,
    itemTypes: result.itemTypes ?? [],
    diagnostics: result.diagnostics ?? null,
    usage: result.usage ?? null,
  };
}

export async function runMacroJudge(input: {
  workingDirectory: string;
  objective: string;
  plan: SLobePlan;
  judgeSeals: JudgeSeal[];
  signal?: AbortSignal;
  timeoutMs: number;
  reasoningEffort: CodexHarnessReasoningEffort;
}): Promise<StructuredRun> {
  const started = performance.now();
  const deadline = started + input.timeoutMs;
  const attempts: JudgeAttemptSummary[] = [];
  let lastResult: StructuredRun | null = null;
  let retryReason: string | undefined;

  for (let index = 0; index < 2; index += 1) {
    if (input.signal?.aborted) break;
    const remainingMs = Math.floor(deadline - performance.now());
    if (remainingMs < 1_000) break;
    const reasoningEffort = index === 0 ? input.reasoningEffort : "medium";
    const attemptTimeoutMs = index === 0 ? Math.min(macroJudgePrimaryBudget(input.timeoutMs), remainingMs) : remainingMs;
    const prompt = buildMacroJudgePrompt(input.objective, input.plan, input.judgeSeals, retryReason);
    let result = await runStructured(
      input.workingDirectory,
      prompt,
      JudgeResultSchema,
      input.signal,
      attemptTimeoutMs,
      "read_only",
      false,
      reasoningEffort,
      { label: `macro judge attempt ${index + 1}`, forbiddenItemTypes: JUDGE_FORBIDDEN_ITEM_TYPES },
    );
    if (result.ok) {
      const decision = result.value as z.infer<typeof JudgeResultSchema>;
      if (!validateJudgeDecision(input.judgeSeals.map((seal) => seal.digest), decision)) {
        result = { ...result, ok: false, value: undefined, error: "judge must classify every supplied lane exactly once and proceed requires at least two accepted lanes" };
      }
    }
    attempts.push(summarizeJudgeAttempt(index + 1, reasoningEffort, attemptTimeoutMs, result));
    if (result.ok) return { ...result, attempts };
    lastResult = result;
    retryReason = result.error ?? "unknown structured judge failure";
  }

  return { ...(lastResult ?? { ok: false, error: input.signal?.aborted ? "macro judge aborted" : "macro judge exhausted its total timeout budget" }), attempts };
}

function impactTelemetry(roster: SLoomRoster, roles: ResolvedSLoomRole[], lanes: LaneExecution[], verdict: string, elapsedMs: number, timeoutMs: number) {
  const successful = lanes.filter((lane) => lane.result.ok).length;
  const cacheHits = lanes.filter((lane) => lane.source === "smart_cache").length;
  const factors = {
    correctness: verdict === "pass" ? 1 : verdict === "partial" ? 0.5 : 0,
    evidence: roles.length === 0 ? 0 : successful / roles.length,
    lensDiversity: roles.length === 0 ? 0 : new Set(roles.map((role) => role.personaGenome.role)).size / roles.length,
    memoryReuse: roles.length === 0 ? 0 : cacheHits / roles.length,
    latency: Math.max(0, 1 - elapsedMs / Math.max(timeoutMs * 2, 1)),
  };
  const weights = roster.composition.impactWeights;
  const score = factors.correctness * weights.correctness + factors.evidence * weights.evidence + factors.lensDiversity * weights.lensDiversity + factors.memoryReuse * weights.memoryReuse + factors.latency * weights.latency;
  return { score: Math.round(score * 10_000) / 10_000, nonGating: true, evidenceClass: "telemetry_estimate", factors, weights, observerCost: { elapsedMs, liveCalls: lanes.filter((lane) => lane.source === "live").length, cacheHits } };
}

export function validateJudgeDigestClassification(suppliedDigests: string[], acceptedDigests: string[], rejectedDigests: string[]): boolean {
  const supplied = new Set(suppliedDigests);
  const classified = [...acceptedDigests, ...rejectedDigests];
  return supplied.size === suppliedDigests.length && classified.every((digest) => supplied.has(digest)) && new Set(classified).size === classified.length && classified.length === supplied.size;
}

export function validateJudgeDecision(suppliedDigests: string[], decision: Pick<z.infer<typeof JudgeResultSchema>, "verdict" | "acceptedLaneDigests" | "rejectedLaneDigests">): boolean {
  return validateJudgeDigestClassification(suppliedDigests, decision.acceptedLaneDigests, decision.rejectedLaneDigests) && (decision.verdict !== "proceed" || decision.acceptedLaneDigests.length >= 2);
}

export function resolveClusterVerdict(input: { earned: boolean; laneSealCount: number; judgeVerdict: "proceed" | "revise" | "collapse" | null; writerOk: boolean | null; verifierVerdict: "pass" | "fail" | "partial" | null }): "pass" | "partial" {
  if (input.writerOk !== null) return input.writerOk && input.verifierVerdict === "pass" ? "pass" : "partial";
  if (!input.earned && input.laneSealCount === 1) return "pass";
  return input.judgeVerdict === "proceed" ? "pass" : "partial";
}

export function registerCodexLoomTools(pi: PiApi): void {
  const roster = loadSLoomRoster();
  const profileNames = Object.keys(roster.looms).sort();

  pi.registerTool({
    name: "habitat_loom_inventory",
    label: "Habitat Loom Inventory",
    description: "Inventory the unchanged Habitat operational roster, the separate harness-owned S Loom Roster, native loom front doors, and LoomLattice WIP status. Read-only.",
    promptSnippet: "Inspect Habitat and S Loom bodies before selecting a native or SOL cognition loom",
    promptGuidelines: ["Keep the Habitat operational roster, S Loom Roster, and LoomLattice WIP evidence distinct.", "Default to direct execution when a loom does not earn its coordination cost."],
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }): Promise<ToolResult> {
      const cwd = workspaceRootFor(ctx.cwd);
      const habitatManifestText = readFileSync(join(cwd, "loom-dependencies", "personas", "PERSONA_MANIFEST.json"), "utf8");
      const habitatManifestSha256 = createHash("sha256").update(habitatManifestText).digest("hex");
      const manifest = JSON.parse(habitatManifestText) as { stacks?: Record<string, { name?: string; personas?: string[] }>; personas?: unknown[]; hard_stops?: string[] };
      const measuredRoster = measureHabitatOperationalRoster(cwd);
      const templates = JSON.parse(readFileSync(join(cwd, "bin", "loom-templates.json"), "utf8")) as { templates?: Record<string, unknown> };
      const workflows = readdirSync(join(cwd, ".claude", "workflows")).filter((name) => /loom|tenterframe|factory-conductor/.test(name)).sort();
      const stacks = Object.entries(manifest.stacks ?? {}).map(([key, stack]) => ({ key, name: stack.name ?? key, width: stack.personas?.length ?? 0, personas: stack.personas ?? [] }));
      const hscFamilies = commandVersion(join(cwd, "bin", "hsc"), ["families"], cwd);
      const details = {
        habitatOperationalRoster: { source: "loom-dependencies/personas/PERSONA_MANIFEST.json", stacks: { count: stacks.length, entries: stacks }, personaGenomes: manifest.personas?.length ?? null, templates: Object.keys(templates.templates ?? {}).sort(), workflows, separationProof: { state: measuredRoster.missing.length > 0 ? "incomplete" : measuredRoster.sha256 === roster.authority.habitatRosterBaselineSha256 ? "verified_baseline_match" : "mismatch", currentSha256: measuredRoster.sha256, expectedSha256: roster.authority.habitatRosterBaselineSha256, manifestSha256: habitatManifestSha256, filesMeasured: measuredRoster.files.length, missing: measuredRoster.missing } },
        sLoomRoster: { id: roster.id, name: roster.name, version: roster.version, status: roster.status, authority: roster.authority, profiles: profileNames.map((profile) => { const module = requireModule(roster, profile); return { profile, id: module.id, roles: module.roles.length, lobeSeat: module.lobeSeat, cacheFamily: module.cache.family }; }), composition: roster.composition, architecture: roster.architecture, personaHotSwap: roster.personaHotSwap, manifestSha256: roster.manifestSha256, hscFamiliesOperational: Boolean(hscFamilies && profileNames.every((profile) => hscFamilies.includes(requireModule(roster, profile).cache.family))) },
        frontDoors: { hb: commandVersion("hb", ["loom", "--help"], cwd) !== null, loomTemplate: "bin/loom-template", loomContract: "bin/loom-contract", loomDispatch: "bin/loom-dispatch", hsc: "bin/hsc" },
        loomLattice: { maturity: "wip_deployment", operationalDependency: false, version: commandVersion(join(cwd, "loom-lattice-habitat", "target", "debug", "lattice"), ["--version"], cwd) },
        solCluster: { tool: "codex_loom_cluster", lobePlanner: "codex_s_lobe_plan", model: roster.runtime.model, laneWidth: `${roster.runtime.width.minimum}-${roster.runtime.width.maximum}`, topology: roster.runtime.topology, judgeIndependence: roster.composition.judgeBarrier },
        hardStops: [...(manifest.hard_stops ?? []), ...roster.hardStops],
      };
      return { content: [{ type: "text", text: truncate(JSON.stringify(details, null, 2)) }], details };
    },
  });

  pi.registerTool({
    name: "codex_s_loom_roster",
    label: "S Loom Roster",
    description: "Read the Zod-validated, modular S Loom Roster including roles, smart-cache policy, persona hot-swap envelopes, ports, composition, and architecture. Read-only.",
    promptSnippet: "Inspect a harness-owned S Loom module or the full modular roster",
    parameters: Type.Object({ profile: Type.Optional(Type.String({ enum: profileNames })) }),
    async execute(_toolCallId: string, params: { profile?: string }): Promise<ToolResult> {
      const details = params.profile ? { roster: { id: roster.id, version: roster.version, manifestSha256: roster.manifestSha256 }, module: roster.looms[params.profile], moduleSha256: roster.moduleSha256[params.profile] } : roster;
      return { content: [{ type: "text", text: truncate(JSON.stringify(details, null, 2)) }], details };
    },
  });

  pi.registerTool({
    name: "codex_s_lobe_plan",
    label: "S Distributed Intelligence Lobe Plan",
    description: "Compose 3-5 compatible S Loom modules into a typed, non-dispatching distributed intelligence lobe plan with hot-swappable personas, smart-cache namespaces, collaboration edges, micro/meso/macro clusters, and transport policy.",
    promptSnippet: "Plan a stacked S Loom distributed intelligence lobe without live model calls or dispatch",
    parameters: Type.Object({
      objective: Type.String(),
      profiles: Type.Array(Type.String({ enum: profileNames }), { minItems: 3, maxItems: 5 }),
      personaSwaps: Type.Optional(Type.Any({ description: "Optional map: profile.roleId or roleId -> persona id" })),
    }),
    async execute(_toolCallId: string, params: { objective: string; profiles: string[]; personaSwaps?: unknown }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }): Promise<ToolResult> {
      const workspace = workspaceRootFor(ctx.cwd);
      const swaps = parsePersonaSwaps(params.personaSwaps);
      const firstProfile = params.profiles[0];
      if (!firstProfile) throw new Error("at least one S Loom profile is required");
      const resolved = resolveExecutionRoles(workspace, roster, firstProfile, undefined, params.profiles, swaps, true);
      const details = buildSLobePlan(roster, resolved.roles, resolved.modules, params.objective);
      return { content: [{ type: "text", text: truncate(JSON.stringify(details, null, 2)) }], details };
    },
  });

  pi.registerTool({
    name: "habitat_loom_plan",
    label: "Habitat Loom Plan",
    description: "Create a native hb loom geometric plan as JSON. This resolves tools, anchors, and leases but never dispatches panes or executes the plan.",
    promptSnippet: "Weave a native nested, hopf, genus, gyroid, stack, or context loom plan",
    promptGuidelines: ["Use plan output as a proposal. Dispatch, ship, deploy, and arming remain separate authority boundaries."],
    parameters: Type.Object({
      geometry: Type.String({ enum: ["nested", "hopf", "genus", "gyroid", "stack", "context"] }),
      intent: Type.String(),
      top: Type.Optional(Type.Number({ description: "Default 12, max 24" })),
      campaign: Type.Optional(Type.String({ description: "Safe campaign slug" })),
      outputPath: Type.Optional(Type.String({ description: "Optional package-relative artifact path" })),
      confirmWrite: Type.Optional(Type.Boolean({ description: "Required when outputPath is set" })),
    }),
    async execute(_toolCallId: string, params: { geometry: string; intent: string; top?: number; campaign?: string; outputPath?: string; confirmWrite?: boolean }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }): Promise<ToolResult> {
      const cwd = workspaceRootFor(ctx.cwd);
      if (params.campaign && !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(params.campaign)) throw new Error(`invalid campaign slug: ${params.campaign}`);
      if (params.outputPath && params.confirmWrite !== true) throw new Error("loom outputPath requires confirmWrite=true");
      const top = Math.min(Math.max(params.top ?? 12, 1), 24);
      const args = ["loom", params.geometry, params.intent, "--top", String(top), "--json", ...(params.campaign ? ["--campaign", params.campaign] : [])];
      const result = spawnSync("hb", args, { cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
      const ok = result.status === 0;
      let written = null;
      if (params.outputPath && ok) written = await scopedWrite({ cwd, relativePath: params.outputPath, content: result.stdout, confirmWrite: true });
      const details = { geometry: params.geometry, intent: params.intent, top, campaign: params.campaign ?? params.geometry, ok, code: result.status, plan: safeJson(result.stdout ?? ""), stderr: result.stderr ?? "", dispatchArmed: false, written };
      return { content: [{ type: "text", text: truncate(JSON.stringify(details, null, 2)) }], details };
    },
  });

  pi.registerTool({
    name: "codex_loom_cluster",
    label: "Codex S Loom / Distributed Lobe",
    description: "Run one modular S Loom or a 3-5-module distributed intelligence lobe: persona-aware read-only lanes, HSC smart memory, an outside-context judge, and optionally one confirmed writer followed by verification.",
    promptSnippet: "Run a smart-cached S Loom or stacked distributed intelligence lobe for complex review, build, debug, architecture, innovation, or harness work",
    promptGuidelines: ["Use only when decomposition, independent lenses, or a judge barrier earns the coordination cost.", "Parallel lanes never write. At most one writer receives workspace-write after judge convergence and explicit confirmation.", "Persona swaps change reasoning, routing, veto, and memory behavior but never widen the fixed read-only lane runtime."],
    parameters: Type.Object({
      objective: Type.String(),
      profile: Type.Optional(Type.String({ enum: profileNames, description: "Standalone S Loom profile; default review" })),
      roles: Type.Optional(Type.Array(Type.String(), { minItems: 3, maxItems: 5, description: "Optional 3-5 explicit lane titles within one module" })),
      stackProfiles: Type.Optional(Type.Array(Type.String({ enum: profileNames }), { minItems: 3, maxItems: 5, description: "Compose 3-5 S Loom modules into one lobe" })),
      personaSwaps: Type.Optional(Type.Any({ description: "Optional map: profile.roleId or roleId -> persona id" })),
      cacheMode: Type.Optional(Type.String({ enum: ["use", "refresh", "off"], description: "Default use; refresh bypasses reads but writes judged seals" })),
      forceLoom: Type.Optional(Type.Boolean({ description: "Bypass the D0 collapse-to-direct gate" })),
      allowLiveCall: Type.Boolean({ description: "Must be true; the cluster makes live SOL calls on cache misses" }),
      workingDirectory: Type.Optional(Type.String()),
      writerMode: Type.Optional(Type.Boolean({ description: "Enable the single writer after judge convergence" })),
      confirmWorkspaceWrite: Type.Optional(Type.Boolean({ description: "Required when writerMode=true" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Per-lane and macro-judge timeout, default 180000, max 600000" })),
    }),
    async execute(_toolCallId: string, params: { objective: string; profile?: string; roles?: string[]; stackProfiles?: string[]; personaSwaps?: unknown; cacheMode?: SLoomCacheMode; forceLoom?: boolean; allowLiveCall?: boolean; workingDirectory?: string; writerMode?: boolean; confirmWorkspaceWrite?: boolean; timeoutMs?: number }, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }): Promise<ToolResult> {
      const started = performance.now();
      if (params.allowLiveCall !== true) throw new Error("codex_loom_cluster requires allowLiveCall=true");
      if (!process.env.OPENAI_API_KEY) throw new Error("codex_loom_cluster requires OPENAI_API_KEY");
      if (params.writerMode === true && params.confirmWorkspaceWrite !== true) throw new Error("writerMode requires confirmWorkspaceWrite=true");
      if (params.roles && params.stackProfiles) throw new Error("provide roles or stackProfiles, not both");
      const cwd = workspaceRootFor(ctx.cwd);
      const workingDirectory = resolveWorkspaceDirectory(ctx.cwd, params.workingDirectory);
      const timeoutMs = Math.min(Math.max(params.timeoutMs ?? 180_000, 1_000), 600_000);
      const requestedCacheMode = params.cacheMode ?? "use";
      const safety = classifyPermission({ cwd, objective: params.objective, command: "codex_loom_cluster", declaredPermissions: params.writerMode ? ["read", "live_openai_call", "workspace_write"] : ["read", "live_openai_call"] });
      if (safety.class === "BLOCK" || safety.class === "GATE") throw new Error(`loom objective refused (${safety.class}): ${safety.reason}`);

      const profile = params.profile ?? "review";
      const earned = Boolean(params.stackProfiles) || loomEarned(params.objective, params.roles, params.forceLoom);
      const swaps = parsePersonaSwaps(params.personaSwaps);
      const resolved = resolveExecutionRoles(cwd, roster, profile, params.roles, params.stackProfiles, swaps, earned);
      const roles = resolved.roles;
      const moduleByProfile = new Map(resolved.modules.map((module) => [module.profile, module]));
      let effectiveCacheMode: SLoomCacheMode = earned ? requestedCacheMode : "off";
      let cacheDisabledReason: string | null = null;
      let workspaceSha256: string;
      try {
        workspaceSha256 = workspaceStateSha(workingDirectory, roster.runtime.cacheRelevantIgnoredPaths);
      } catch (error) {
        cacheDisabledReason = error instanceof Error ? error.message : String(error);
        effectiveCacheMode = "off";
        workspaceSha256 = createHash("sha256").update(`uncacheable:${workingDirectory}:${cacheDisabledReason}:${Date.now()}`).digest("hex");
      }

      const laneSettled = await Promise.all(roles.map(async (role): Promise<LaneExecution> => {
        const module = moduleByProfile.get(role.profile) ?? requireModule(roster, role.profile);
        const binding = createCacheBinding(module, role, params.objective, workingDirectory, roster.manifestSha256, requireModuleSha(roster, role.profile), workspaceSha256);
        const read = readSLoomCache(cwd, binding, effectiveCacheMode);
        if (read.state === "hit" && read.entry?.kind === "judged_lane_seal") {
          const parsed = LaneResultSchema.safeParse(read.entry.value);
          if (parsed.success) return { profile: role.profile, moduleId: module.id, roleId: role.id, role: role.title, persona: personaSummary(role), source: "smart_cache", result: { ok: true, value: parsed.data, runtime: { cache: true } }, cacheRead: cacheReadSummary(read) };
        }
        const reasoning = earned ? roster.runtime.reasoning.readers : roster.runtime.reasoning.direct;
        const result = await runStructured(workingDirectory, lanePrompt(params.objective, role, module, roster.runtime.terminalCommandBudgetPerReader), LaneResultSchema, signal, timeoutMs, "read_only", false, reasoning);
        return { profile: role.profile, moduleId: module.id, roleId: role.id, role: role.title, persona: personaSummary(role), source: "live", result, cacheRead: cacheReadSummary(read) };
      }));
      const judgeSeals = buildJudgeSeals(laneSettled, roles);
      const lobePlan = buildSLobePlan(roster, roles, resolved.modules, params.objective);

      let judge: StructuredRun | null = null;
      if (earned && judgeSeals.length >= 2) {
        judge = await runMacroJudge({
          workingDirectory,
          objective: params.objective,
          plan: lobePlan,
          judgeSeals,
          timeoutMs,
          reasoningEffort: roster.runtime.reasoning.judge,
          ...(signal ? { signal } : {}),
        });
      }

      let writer: StructuredRun | null = null;
      if (params.writerMode === true && judge?.ok && (judge.value as z.infer<typeof JudgeResultSchema>).verdict === "proceed") {
        const writerPrompt = [
          "You are the sole writer lane in an S Loom cluster. No other lane may mutate this worktree.",
          `Objective: ${params.objective}`,
          `Judged plan: ${truncate(JSON.stringify(judge.value), 18_000)}`,
          "Implement the smallest coherent change, use native terminal tools, and run focused verification.",
          "Do not deploy, push, ship, publish, tag, modify .git internals, or start daemons/servers.",
          "Return only the structured task result.",
        ].join("\n");
        writer = await runStructured(workingDirectory, writerPrompt, HARNESS_ZOD_SCHEMAS.sol56_task_result, signal, timeoutMs, "workspace_write", true, roster.runtime.reasoning.writer);
      }

      let verifier: StructuredRun | null = null;
      if (writer?.ok) {
        const verifierPrompt = [
          "You are the read-only verifier outside the writer loop.",
          `Objective: ${params.objective}`,
          `Writer seal: ${truncate(JSON.stringify(writer.value), 12_000)}`,
          "Inspect the resulting diff and available verification evidence. Do not modify files.",
          "Return only the structured verification result.",
        ].join("\n");
        verifier = await runStructured(workingDirectory, verifierPrompt, VerificationResultSchema, signal, timeoutMs, "read_only", false, roster.runtime.reasoning.verifier);
      }

      const judgeVerdict = judge?.ok ? (judge.value as z.infer<typeof JudgeResultSchema>).verdict : null;
      const verdict = resolveClusterVerdict({
        earned,
        laneSealCount: judgeSeals.length,
        judgeVerdict,
        writerOk: writer ? writer.ok : null,
        verifierVerdict: verifier?.ok ? (verifier.value as z.infer<typeof VerificationResultSchema>).verdict : null,
      });
      const preliminaryImpact = impactTelemetry(roster, roles, laneSettled, verdict, performance.now() - started, timeoutMs);
      const report = {
        schema: resolved.lobe ? "codex-harness.sol56-distributed-lobe.v1" : "codex-harness.sol56-s-loom.v1",
        roster: { id: roster.id, version: roster.version, manifestSha256: roster.manifestSha256 },
        profile: resolved.lobe ? "stacked-lobe" : profile,
        modules: resolved.modules.map((module) => ({ profile: module.profile, id: module.id, moduleSha256: requireModuleSha(roster, module.profile), cacheFamily: module.cache.family })),
        objective: params.objective,
        topology: resolved.lobe ? "parallel_meso_looms_then_macro_judge_then_optional_single_writer" : earned ? "parallel_micro_readers_then_module_judge_then_optional_single_writer" : "d0_collapsed_direct",
        architecture: roster.architecture,
        reasoningTopology: earned ? roster.runtime.reasoning : { direct: roster.runtime.reasoning.direct },
        earned,
        lobePlan,
        judgeSeals,
        personaHotSwaps: roles.filter((role) => role.swapState === "hot_swapped").map((role) => ({ profile: role.profile, roleId: role.id, persona: role.personaGenome.id, genomeSha256: role.personaSha256 })),
        lanes: laneSettled,
        judge,
        writer,
        verifier,
        cache: { requestedMode: requestedCacheMode, mode: effectiveCacheMode, disabledReason: cacheDisabledReason, reads: laneSettled.map((lane) => lane.cacheRead), writes: [] as unknown[] },
        impact: preliminaryImpact,
        verdict,
        safety,
        hardStops: roster.hardStops,
      };
      const artifactStamp = Date.now();
      const admissionArtifact = await writeJsonArtifact(cwd, `loom-clusters/sol56-s-loom-${artifactStamp}-admission.json`, report);
      const proofRef = `${admissionArtifact.path}@sha256:${admissionArtifact.sha256}`;
      const acceptedDigests = new Set(judge?.ok && judgeVerdict === "proceed" ? (judge.value as z.infer<typeof JudgeResultSchema>).acceptedLaneDigests : []);
      const cacheWrites = laneSettled.map((lane) => {
        const role = roles.find((candidate) => candidate.profile === lane.profile && candidate.id === lane.roleId);
        if (!role) throw new Error(`missing resolved role for cache write: ${lane.profile}.${lane.roleId}`);
        const module = moduleByProfile.get(role.profile) ?? requireModule(roster, role.profile);
        const readBinding = (lane.cacheRead.binding ?? createCacheBinding(module, role, params.objective, workingDirectory, roster.manifestSha256, requireModuleSha(roster, role.profile), workspaceSha256)) as ReturnType<typeof createCacheBinding>;
        if (lane.source === "smart_cache") return { state: "bypassed", reason: "existing judged memory reused", binding: readBinding };
        const judgeSeal = judgeSeals.find((seal) => seal.profile === lane.profile && seal.roleId === lane.roleId);
        if (lane.result.ok && judgeSeal && acceptedDigests.has(judgeSeal.digest)) return writeSLoomCache(cwd, readBinding, role, "judged_lane_seal", judgeSeal.seal, proofRef, judgeVerdict, effectiveCacheMode, judgeSeal.digest);
        if (!lane.result.ok) return { state: "bypassed", reason: "unclassified runtime/model/transport failures are never admitted as traps", binding: readBinding };
        return { state: "bypassed", reason: "cache admission requires proceed and explicit judge acceptance of the exact lane digest", binding: readBinding };
      });
      report.cache.writes = cacheWrites;
      const artifact = await writeJsonArtifact(cwd, `loom-clusters/sol56-s-loom-${artifactStamp}.json`, report);

      const envelope = createBaseEnvelope({
        cwd,
        objective: `${resolved.lobe ? "S distributed intelligence lobe" : "S Loom"}: ${params.objective}`,
        kind: params.writerMode ? "codex_thread" : "review",
        verdict,
        safety: {
          class: params.writerMode ? "DEFER" : "AUTO",
          reason: params.writerMode ? "read-only lanes; one confirmed workspace writer after judge barrier" : "read-only S Loom lanes plus provenance-backed derived cache and receipt writes",
          declaredPermissions: params.writerMode ? ["read", "live_openai_call", "workspace_write", "local_cache_write"] : ["read", "live_openai_call", "local_cache_write"],
          observedEffects: [admissionArtifact.path, artifact.path, ...cacheWrites.filter((write) => "state" in write && write.state === "written").map((write) => `hsc:${write.binding.family}/${write.binding.key}`)],
          permissionDelta: "expected",
        },
      });
      envelope.artifacts.push(admissionArtifact, artifact);
      const receipt = await appendReceipt(cwd, envelope);
      const details = { ...report, admissionArtifact, artifact, receipt: { path: receipt.path, eventHash: receipt.eventHash, verified: receipt.verified } };
      const summary = {
        schema: report.schema,
        roster: report.roster,
        profile: report.profile,
        objective: report.objective,
        earned: report.earned,
        verdict: report.verdict,
        modules: report.modules,
        lanes: laneSettled.map((lane) => ({ profile: lane.profile, roleId: lane.roleId, persona: lane.persona.id, source: lane.source, ok: lane.result.ok, error: lane.result.error ?? null })),
        judge: { ok: judge?.ok ?? false, verdict: judgeVerdict, acceptedLaneDigestCount: judge?.ok ? (judge.value as z.infer<typeof JudgeResultSchema>).acceptedLaneDigests.length : 0, rejectedLaneDigestCount: judge?.ok ? (judge.value as z.infer<typeof JudgeResultSchema>).rejectedLaneDigests.length : 0, error: judge?.error ?? null, diagnostics: judge?.diagnostics ?? null, attempts: judge?.attempts ?? [] },
        writer: { requested: params.writerMode === true, ok: writer?.ok ?? false, error: writer?.error ?? null },
        verifier: { ran: verifier !== null, ok: verifier?.ok ?? false, verdict: verifier?.ok ? (verifier.value as z.infer<typeof VerificationResultSchema>).verdict : null, error: verifier?.error ?? null },
        personaHotSwaps: report.personaHotSwaps,
        cache: { requestedMode: report.cache.requestedMode, mode: report.cache.mode, disabledReason: report.cache.disabledReason, reads: laneSettled.map((lane) => ({ roleId: lane.roleId, state: lane.cacheRead.state })), writes: cacheWrites.map((write) => ({ state: write.state, family: write.binding.family, key: write.binding.key })) },
        impact: report.impact,
        admissionArtifact,
        artifact,
        receipt: details.receipt,
      };
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }], details };
    },
  });
}
