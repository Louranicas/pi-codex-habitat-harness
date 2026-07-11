import codexHarnessExtension from "../extensions/index.js";

type ToolDefinition = {
  name?: string;
  execute?: (...args: unknown[]) => Promise<{ details?: unknown }>;
};

type ObserveProof = {
  schema: string;
  profile: string;
  verdict: string;
  lanes: Array<{ roleId: string; persona: { id: string }; result: { ok: boolean; error?: string } }>;
  judge: {
    ok?: boolean;
    value?: { verdict?: string };
    error?: string;
    diagnostics?: unknown;
    attempts?: unknown[];
  } | null;
  cache: { mode: string; disabledReason: string | null };
  admissionArtifact: unknown;
  artifact: unknown;
  receipt: unknown;
};

const LIVE_TIMEOUT_MS = 480_000;

if (!process.argv.includes("--confirm-live")) {
  throw new Error("live observe proof requires --confirm-live; this run makes up to five SOL calls");
}

const tools = new Map<string, ToolDefinition>();
codexHarnessExtension({
  registerCommand: () => undefined,
  registerTool: (definition: ToolDefinition) => tools.set(String(definition.name), definition),
});

const tool = tools.get("codex_loom_cluster");
if (!tool?.execute) throw new Error("codex_loom_cluster is not registered");

const result = await tool.execute(
  "observe-live-proof",
  {
    objective: "Evaluate the new observe profile against its source contract. Produce evidence for log correlation, SLO calculation, benchmark comparability, and readiness proof quality. This is read-only evidence work with no actuation.",
    profile: "observe",
    forceLoom: true,
    allowLiveCall: true,
    cacheMode: "off",
    timeoutMs: LIVE_TIMEOUT_MS,
  },
  undefined,
  undefined,
  { cwd: new URL("../..", import.meta.url).pathname },
);

const details = result.details as ObserveProof;
console.log(JSON.stringify({
  schema: details.schema,
  profile: details.profile,
  timeoutMs: LIVE_TIMEOUT_MS,
  verdict: details.verdict,
  lanes: details.lanes.map((lane) => ({ roleId: lane.roleId, persona: lane.persona.id, ok: lane.result.ok, error: lane.result.error ?? null })),
  judge: {
    ok: details.judge?.ok ?? false,
    verdict: details.judge?.value?.verdict ?? null,
    error: details.judge?.error ?? null,
    diagnostics: details.judge?.diagnostics ?? null,
    attempts: details.judge?.attempts ?? [],
  },
  cache: details.cache,
  admissionArtifact: details.admissionArtifact,
  artifact: details.artifact,
  receipt: details.receipt,
}, null, 2));
