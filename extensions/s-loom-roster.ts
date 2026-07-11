import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const ReasoningEffortSchema = z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]);
const PermissionClassSchema = z.enum(["design_read_only", "review_read_only", "memory_read"]);

const RoleMemorySchema = z.object({
  namespace: z.string().regex(/^s-loom\/[a-z0-9-]+\/[a-z0-9-]+$/),
  priorityFields: z.array(z.enum(["finding", "evidence", "risks", "recommendation", "confidence"])).min(1),
  evidenceLimit: z.number().int().min(1).max(20),
  riskLimit: z.number().int().min(1).max(20),
  maxFieldChars: z.number().int().min(256).max(8_000),
  ttlSeconds: z.number().int().min(30).max(86_400),
  negativeEdgeOnFailure: z.literal(false),
  personaPartitioned: z.literal(true),
});

const PersonaPolicySchema = z.object({
  defaultPersona: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  compatibleRoles: z.array(z.string().min(1)).min(1),
  allowedPermissionClasses: z.array(PermissionClassSchema).min(1),
  maximumContextTokens: z.number().int().min(1_000).max(64_000),
  requiresProvenance: z.literal(true),
});

export const SLoomRoleSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1),
  mission: z.string().min(1),
  evidenceContract: z.array(z.string().min(1)).min(1),
  persona: PersonaPolicySchema,
  memory: RoleMemorySchema,
});

export const SLoomModuleSchema = z.object({
  schema: z.literal("codex-harness.s-loom-module.v1"),
  profile: z.string().regex(/^[a-z][a-z0-9-]*$/),
  id: z.string().regex(/^s-[a-z0-9-]+$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  sphere: z.literal("meso"),
  purpose: z.string().min(1),
  activationSignals: z.array(z.string().min(1)).min(1),
  lobeSeat: z.string().min(1),
  compatibleWith: z.array(z.string().min(1)).min(1),
  ports: z.object({
    accepts: z.array(z.string().min(1)).min(1),
    emits: z.array(z.string().min(1)).min(1),
    barrier: z.literal("outside_context_judge"),
  }),
  clusterContract: z.object({
    micro: z.array(z.object({
      roleId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
      loop: z.string().min(1),
      evidence: z.string().min(1),
    })).min(3).max(5),
    meso: z.string().min(1),
    macro: z.string().min(1),
    antiGoodhart: z.array(z.string().min(1)).min(1),
  }).optional(),
  cache: z.object({
    family: z.string().regex(/^s_loom_[a-z0-9_]+$/),
    admission: z.literal("causal"),
    invalidation: z.literal("content_sha"),
    maxEntries: z.number().int().min(8).max(512),
  }),
  roles: z.array(SLoomRoleSchema).min(3).max(5),
}).superRefine((module, ctx) => {
  const ids = module.roles.map((role) => role.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "role ids must be unique" });
  if (!ids.includes(module.lobeSeat)) ctx.addIssue({ code: "custom", message: "lobeSeat must identify a module role" });
  if (new Set(module.compatibleWith).size !== module.compatibleWith.length) ctx.addIssue({ code: "custom", message: "compatibleWith entries must be unique" });
  if (module.compatibleWith.includes(module.profile)) ctx.addIssue({ code: "custom", message: "a module cannot list itself in compatibleWith" });
  if (module.clusterContract) {
    const clusterIds = module.clusterContract.micro.map((loop) => loop.roleId);
    if (new Set(clusterIds).size !== clusterIds.length || clusterIds.length !== ids.length || clusterIds.some((id) => !ids.includes(id))) {
      ctx.addIssue({ code: "custom", message: "clusterContract.micro must cover every module role exactly once" });
    }
  }
});

export const SLoomRosterManifestSchema = z.object({
  schema: z.literal("codex-harness.s-loom-roster.v1"),
  id: z.literal("s-loom-roster"),
  name: z.literal("S Loom Roster"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  status: z.literal("harness_operational"),
  authority: z.object({
    scope: z.literal("codex_harness_sol_cognition"),
    habitatOperationalRoster: z.literal("external_unchanged"),
    habitatRosterBaselineSha256: z.string().length(64),
    loomLattice: z.literal("wip_advisory_only"),
  }),
  runtime: z.object({
    model: z.literal("gpt-5.6-sol"),
    d0Policy: z.literal("collapse_to_direct"),
    width: z.object({ minimum: z.literal(3), default: z.number().int().min(3).max(5), maximum: z.literal(5) }),
    reasoning: z.object({ direct: ReasoningEffortSchema, readers: ReasoningEffortSchema, judge: ReasoningEffortSchema, writer: ReasoningEffortSchema, verifier: ReasoningEffortSchema }),
    terminalCommandBudgetPerReader: z.number().int().min(1).max(20),
    cacheRelevantIgnoredPaths: z.array(z.string().min(1).refine((path) => !isAbsolute(path) && !path.split(/[\\/]/).includes(".."), "cache-relevant path must stay relative")),
    topology: z.literal("parallel_readers_then_outside_context_judge_then_optional_single_writer_then_verifier"),
  }),
  composition: z.object({
    protocol: z.literal("s-loom-seal-bus.v1"),
    pattern: z.literal("parallel_meso_looms_under_one_macro"),
    minimumModules: z.literal(3),
    maximumModules: z.literal(5),
    maximumRoutingDepth: z.number().int().min(1).max(4),
    sharedStateRule: z.literal("exchange_seals_and_cache_references_never_mutable_state"),
    memoryTransport: z.literal("hsc_role_persona_partitioned_cache"),
    judgeBarrier: z.literal("outside_context_same_model_family"),
    impactWeights: z.object({ correctness: z.number().min(0).max(1), evidence: z.number().min(0).max(1), lensDiversity: z.number().min(0).max(1), memoryReuse: z.number().min(0).max(1), latency: z.number().min(0).max(1) })
      .refine((weights) => Math.abs(Object.values(weights).reduce((sum, weight) => sum + weight, 0) - 1) < 1e-9, "impact weights must sum to 1"),
  }),
  architecture: z.object({
    containmentGeometry: z.literal("nested_torus"),
    laneSeparationGeometry: z.literal("hopf_fibers"),
    sharedMediumGeometry: z.literal("gyroid"),
    proofGeometry: z.literal("geodesic"),
    clusters: z.object({ micro: z.string().min(1), meso: z.string().min(1), macro: z.string().min(1) }),
    transport: z.object({
      sameOwner: z.literal("in_process"),
      oneShotWorker: z.literal("bounded_stdio_pipe"),
      sharedMemory: z.literal("hsc_cache_reference"),
      crossProcessLongLived: z.literal("versioned_unix_socket_when_endpoint_exists"),
      durableTruth: z.literal("artifact_and_hash_chained_receipt"),
    }),
    unixSocketPolicy: z.literal("do_not_create_a_daemon_when_in_process_or_stdio_is_faster_and_safer"),
  }),
  personaHotSwap: z.object({
    source: z.literal("loom-dependencies/personas/PERSONA_MANIFEST.json"),
    genomePattern: z.literal("loom-dependencies/personas/<id>.persona.json"),
    runtimeEnvelope: z.literal("fixed_read_only_for_all_reader_seats"),
    permissionWidening: z.literal("refuse"),
    nullForce: z.literal("refuse"),
    memoryPartition: z.literal("loom_profile_role_persona_workspace_objective"),
  }),
  modules: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), z.string().regex(/^rosters\/s-looms\/[a-z0-9-]+\.json$/)),
  sourceAnchors: z.array(z.string().min(1)).min(1),
  hardStops: z.array(z.string().min(1)).min(1),
});

const PersonaGenomeSchema = z.object({
  id: z.string(),
  role: z.string(),
  permission_envelope: z.object({
    permission_class: z.string(),
    safety_class: z.string(),
    allowed_tools: z.array(z.string()),
    denied_tools: z.array(z.string()),
    can_widen_without_human: z.boolean(),
  }),
  memory_scope: z.object({
    substrates: z.array(z.string()),
    namespaces: z.array(z.string()),
    max_context_tokens: z.number().int(),
    requires_provenance: z.boolean(),
  }),
  collaboration_contract: z.object({
    speaks_to: z.array(z.string()),
    listens_to: z.array(z.string()),
    vetoes: z.array(z.string()),
    handoff_required: z.boolean(),
  }),
  routing_bias: z.object({ preferred_geometry: z.string() }).passthrough(),
}).passthrough();

const PersonaManifestSchema = z.object({
  personas: z.array(z.object({
    id: z.string(),
    role: z.string(),
    permission_class: z.string(),
    safety_class: z.string(),
    preferred_geometry: z.string(),
  }).passthrough()),
}).passthrough().superRefine((manifest, ctx) => {
  const ids = manifest.personas.map((persona) => persona.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "persona manifest ids must be unique" });
});

export type SLoomRole = z.infer<typeof SLoomRoleSchema>;
export type SLoomModule = z.infer<typeof SLoomModuleSchema>;
export type SLoomRosterManifest = z.infer<typeof SLoomRosterManifestSchema>;
export type PersonaGenome = z.infer<typeof PersonaGenomeSchema>;
export type SLoomRoster = SLoomRosterManifest & { looms: Record<string, SLoomModule>; manifestSha256: string; moduleSha256: Record<string, string> };

export interface ResolvedSLoomRole extends SLoomRole {
  profile: string;
  personaGenome: PersonaGenome;
  personaSha256: string;
  swapState: "default" | "hot_swapped";
}

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const S_LOOM_ROSTER_PATH = join(packageRoot, "rosters", "s-loom-roster.json");

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function readJsonWithSha(path: string): { value: unknown; sha256: string } {
  const text = readFileSync(path, "utf8");
  return { value: JSON.parse(text) as unknown, sha256: sha256(text) };
}

function resolvePackagePath(relativePath: string): string {
  const candidate = resolve(packageRoot, relativePath);
  const rel = relative(packageRoot, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`S Loom path escapes package: ${relativePath}`);
  return candidate;
}

export function loadSLoomRoster(): SLoomRoster {
  const manifestSource = readJsonWithSha(S_LOOM_ROSTER_PATH);
  const manifest = SLoomRosterManifestSchema.parse(manifestSource.value);
  const looms: Record<string, SLoomModule> = {};
  const moduleSha256: Record<string, string> = {};
  for (const [profile, modulePath] of Object.entries(manifest.modules)) {
    const source = readJsonWithSha(resolvePackagePath(modulePath));
    const module = SLoomModuleSchema.parse(source.value);
    if (module.profile !== profile) throw new Error(`S Loom module profile mismatch: ${profile} != ${module.profile}`);
    looms[profile] = module;
    moduleSha256[profile] = source.sha256;
  }
  for (const [profile, module] of Object.entries(looms)) {
    for (const peer of module.compatibleWith) {
      if (!looms[peer]) throw new Error(`S Loom ${profile} names unknown compatible module ${peer}`);
    }
  }
  return { ...manifest, looms, manifestSha256: manifestSource.sha256, moduleSha256 };
}

export function loadPersonaGenome(workspace: string, personaId: string): { genome: PersonaGenome; sha256: string } {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(personaId)) throw new Error(`invalid persona id: ${personaId}`);
  const manifestSource = readJsonWithSha(join(workspace, "loom-dependencies", "personas", "PERSONA_MANIFEST.json"));
  const manifest = PersonaManifestSchema.parse(manifestSource.value);
  const manifestEntry = manifest.personas.find((persona) => persona.id === personaId);
  if (!manifestEntry) throw new Error(`persona ${personaId} is not registered in PERSONA_MANIFEST.json`);
  const source = readJsonWithSha(join(workspace, "loom-dependencies", "personas", `${personaId}.persona.json`));
  const genome = PersonaGenomeSchema.parse(source.value);
  if (genome.id !== personaId) throw new Error(`persona id mismatch: ${personaId} != ${genome.id}`);
  if (manifestEntry.role !== genome.role || manifestEntry.permission_class !== genome.permission_envelope.permission_class || manifestEntry.safety_class !== genome.permission_envelope.safety_class || manifestEntry.preferred_geometry !== genome.routing_bias.preferred_geometry) {
    throw new Error(`persona ${personaId} manifest summary does not match its genome`);
  }
  return { genome, sha256: source.sha256 };
}

export function measureHabitatOperationalRoster(workspace: string): { sha256: string; files: string[]; missing: string[] } {
  const manifestPath = join(workspace, "loom-dependencies", "personas", "PERSONA_MANIFEST.json");
  const manifest = PersonaManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")) as unknown);
  const relativePaths = new Set<string>([
    "loom-dependencies/personas/PERSONA_MANIFEST.json",
    "justfile",
    "bin/hopf-anchor",
    "config/loom-proof-policy.json",
    "schemas/loom_contract.schema.json",
    "schemas/loom_receipt.schema.json",
  ]);
  for (const persona of manifest.personas) relativePaths.add(`loom-dependencies/personas/${persona.id}.persona.json`);
  for (const name of readdirSync(join(workspace, "bin")).filter((entry) => /^loom-/.test(entry))) relativePaths.add(`bin/${name}`);
  for (const name of readdirSync(join(workspace, ".claude", "workflows")).filter((entry) => /loom|tenterframe|factory-conductor/.test(entry))) relativePaths.add(`.claude/workflows/${name}`);

  const digest = createHash("sha256");
  const files = [...relativePaths].sort();
  const missing: string[] = [];
  for (const relativePath of files) {
    const path = join(workspace, relativePath);
    digest.update(relativePath).update("\0");
    if (!existsSync(path)) {
      missing.push(relativePath);
      digest.update("<missing>").update("\0");
      continue;
    }
    digest.update(readFileSync(path)).update("\0");
  }
  return { sha256: digest.digest("hex"), files, missing };
}

function behaviorFingerprint(genome: PersonaGenome): string {
  return JSON.stringify({
    geometry: genome.routing_bias.preferred_geometry,
    tools: [...genome.permission_envelope.allowed_tools].sort(),
    memory: [...genome.memory_scope.namespaces].sort(),
    vetoes: [...genome.collaboration_contract.vetoes].sort(),
  });
}

export function resolveSLoomRole(workspace: string, profile: string, role: SLoomRole, requestedPersona?: string): ResolvedSLoomRole {
  const defaultSource = loadPersonaGenome(workspace, role.persona.defaultPersona);
  const selectedId = requestedPersona ?? role.persona.defaultPersona;
  const selectedSource = selectedId === role.persona.defaultPersona ? defaultSource : loadPersonaGenome(workspace, selectedId);
  const selected = selectedSource.genome;
  if (!role.persona.compatibleRoles.includes(selected.role)) throw new Error(`persona ${selected.id} role ${selected.role} is incompatible with S Loom role ${role.id}`);
  if (!role.persona.allowedPermissionClasses.includes(selected.permission_envelope.permission_class as z.infer<typeof PermissionClassSchema>)) throw new Error(`persona ${selected.id} permission class ${selected.permission_envelope.permission_class} would widen S Loom role ${role.id}`);
  if (selected.permission_envelope.can_widen_without_human) throw new Error(`persona ${selected.id} can widen without human; hot-swap refused`);
  if (!selected.memory_scope.requires_provenance || selected.memory_scope.max_context_tokens > role.persona.maximumContextTokens) throw new Error(`persona ${selected.id} memory envelope exceeds S Loom role ${role.id}`);
  if (selectedId !== role.persona.defaultPersona && behaviorFingerprint(selected) === behaviorFingerprint(defaultSource.genome)) throw new Error(`persona hot-swap ${role.persona.defaultPersona} -> ${selectedId} is null force`);
  return { ...role, profile, personaGenome: selected, personaSha256: selectedSource.sha256, swapState: selectedId === role.persona.defaultPersona ? "default" : "hot_swapped" };
}
