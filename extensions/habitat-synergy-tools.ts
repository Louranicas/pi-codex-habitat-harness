import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import { join, relative } from "node:path";
import { Type } from "typebox";
import { appendReceipt } from "./codex-receipts.js";
import { classifyPermission } from "./codex-safety-membrane.js";
import { workspaceRootFor } from "./package-identity.js";
import { createBaseEnvelope } from "./run-envelope.js";
import { scopedWrite } from "./write-capacity.js";

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
}

type PiApi = {
  registerTool: (definition: Record<string, unknown>) => void;
};

const READ_ONLY_JUST_RECIPES = new Set([
  "sweep",
  "tensor",
  "factory-status-json",
  "factory-status-explain",
  "factory-wiring-json",
  "factory-panel-snapshot-json",
  "factory-substrate-gate-json",
  "memory-substrate-check-json",
  "factory-cockpit-json",
  "factory-zero-touch-arena-preview",
  "factory-context-json",
  "factory-recommend-json",
  "factory-security-json",
  "factory-signal-classify",
  "loom-templates",
  "loom-show",
  "loom-plan",
  "loom-context",
  "loom-campaigns",
  "loom-fibers",
  "loom-trace",
  "plan-profiles",
  "plan-status",
  "comms-hierarchy",
  "comms-channels",
  "comms-fast",
  "cci-json",
]);

const QUALITY_JUST_RECIPES = new Set([
  "gate",
  "law",
  "factory-adversary",
  "factory-arm-check",
  "factory-bridge-check",
  "factory-deploy-check",
  "factory-module-check",
  "factory-rollback-drill",
  "factory-status-check",
  "loom-clusters-check",
  "loom-contract-check",
  "loom-core-check",
  "loom-fixtures-check",
  "loom-personas-check",
  "loom-policy-check",
  "loom-receipt-check",
  "loom-score",
  "loom-seeds-check",
  "loom-stack-status",
  "loom-triad-contract-check",
  "loom-triad-gate",
  "loom-triad-test",
  "loom-vault-verify",
]);

const OPS_JUST_RECIPES = new Set([
  "factory-evidence",
  "factory-evidence-json",
  "factory-security-receipt",
  "factory-wiring-receipt",
  "memory-substrate-receipt",
]);

const RUNBOOK_ROOTS = [
  "ai_docs",
  "factory-map",
  "habitat-graph/runbooks",
  "habitat-graph/ai_docs",
  "orac-sidecar/ai_docs",
  "synthex-v2/ai_docs",
  "the-workflow-engine/ai_docs",
  "the-workflow-engine-v2",
  "loom-lattice-habitat/runbooks",
];

const LIVE_ENDPOINTS = {
  devops: { port: 8082, path: "/health" },
  nerve: { port: 8083, path: "/health" },
  toollib: { port: 8085, path: "/health" },
  synthex: { port: 8092, path: "/health" },
  synthex_thermal: { port: 8092, path: "/v3/thermal" },
  codesynthor: { port: 8111, path: "/health" },
  vms: { port: 8120, path: "/health" },
  povm: { port: 8125, path: "/health" },
  rm: { port: 8130, path: "/health" },
  pv2: { port: 8132, path: "/health" },
  orac: { port: 8133, path: "/health" },
  habitat_memory: { port: 8140, path: "/health" },
  wfe: { port: 8142, path: "/health" },
  wfe2: { port: 8143, path: "/health" },
  architect: { port: 8144, path: "/health" },
  me: { port: 8180, path: "/api/health" },
  lcm: { port: 8200, path: "/health" },
  tierwright: { port: 8201, path: "/health" },
  pswarm: { port: 10002, path: "/health" },
} as const;

type LiveEndpointName = keyof typeof LIVE_ENDPOINTS;

function truncate(text: string, maxChars = 24_000): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]`;
}

function execOptional(command: string, args: string[], cwd: string, timeout = 10_000, input?: string): { ok: boolean; code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout, input, maxBuffer: 2 * 1024 * 1024 });
  return { ok: result.status === 0, code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function commandOutput(command: string, args: string[], cwd: string, timeout = 10_000): string | null {
  try {
    return execFileSync(command, args, { cwd, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

async function probeHttp(port: number, path: string): Promise<{ ok: boolean; statusCode: number | null; bodySample: string; error: string | null }> {
  return await new Promise((resolve) => {
    const req = http.get({ hostname: "127.0.0.1", port, path, timeout: 1_200 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ ok: Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 300), statusCode: res.statusCode ?? null, bodySample: body.slice(0, 500), error: null }));
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, statusCode: null, bodySample: "", error: "timeout" });
    });
    req.on("error", (error) => resolve({ ok: false, statusCode: null, bodySample: "", error: error.message }));
  });
}

function collectRunbooks(cwd: string, query: string, limit: number): Array<{ path: string; title: string; matches: string[] }> {
  const out: Array<{ path: string; title: string; matches: string[] }> = [];
  const needle = query.toLowerCase();
  const visit = (dir: string): void => {
    if (out.length >= limit || !existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (out.length >= limit) return;
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory() && !name.startsWith(".") && name !== "node_modules" && name !== "target") visit(path);
      if (!st.isFile() || !name.endsWith(".md")) continue;
      const text = readFileSync(path, "utf8");
      const lower = text.toLowerCase();
      const rel = relative(cwd, path);
      const runbookish = /runbook|rollback|abort|verification|deploy|operator|authority|factory|zellij|loom|workflow/i.test(text + rel);
      if (!runbookish || (needle && !lower.includes(needle) && !rel.toLowerCase().includes(needle))) continue;
      const title = text.split("\n").find((line) => line.startsWith("#"))?.replace(/^#+\s*/, "") ?? rel;
      const matches = text.split("\n").map((line, index) => ({ line, index: index + 1 }))
        .filter((row) => !needle || row.line.toLowerCase().includes(needle))
        .slice(0, 5)
        .map((row) => `${row.index}: ${row.line.slice(0, 220)}`);
      out.push({ path: rel, title, matches });
    }
  };
  for (const root of RUNBOOK_ROOTS) visit(join(cwd, root));
  return out;
}

function readRunbook(cwd: string, candidate: string): { path: string; title: string; format: "markdown" | "toml"; text: string } {
  const resolved = join(cwd, candidate);
  const rel = relative(cwd, resolved);
  const allowed = RUNBOOK_ROOTS.some((root) => {
    const fromRoot = relative(join(cwd, root), resolved);
    return fromRoot !== ".." && !fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !fromRoot.startsWith("../") && !fromRoot.startsWith("..\\");
  });
  const format = candidate.endsWith(".md") ? "markdown" : candidate.endsWith(".toml") ? "toml" : null;
  if (!allowed || rel.startsWith("..") || !format) throw new Error(`runbook path refused: ${candidate}`);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) throw new Error(`runbook not found: ${candidate}`);
  const text = readFileSync(resolved, "utf8");
  const title = format === "markdown"
    ? text.split("\n").find((line) => line.startsWith("#"))?.replace(/^#+\s*/, "") ?? rel
    : text.match(/^title\s*=\s*["']([^"']+)["']/m)?.[1] ?? text.match(/^id\s*=\s*["']([^"']+)["']/m)?.[1] ?? rel;
  return { path: rel, title, format, text };
}

function latticeBinary(cwd: string): string {
  return join(cwd, "loom-lattice-habitat", "target", "debug", "lattice");
}

function classifyJustRecipe(cwd: string, recipe: string, source: string): { class: "observe" | "quality" | "ops" | "mutating" | "armed" | "unknown"; reasons: string[]; source: "operational_harness"; loomLatticePreview: string | null } {
  const hardStop = /\b(?:git\s+(?:push|commit|tag)|deploy|ship|publish|restart|factory\.authorize|zellij\s+(?:action|pipe)|kubectl\s+apply|docker\s+push|systemctl|daemon\s+start|fabric\s+--serve)\b/i;
  const mutation = /(?:\brm\b|\bcp\s+-f\b|\bmv\s+-f\b|\bsed\s+-i\b|--execute\b|--apply\b)/i;
  let classification: "observe" | "quality" | "ops" | "mutating" | "armed" | "unknown" = "unknown";
  const reasons: string[] = [];
  if (hardStop.test(`${recipe}\n${source}`)) {
    classification = "armed";
    reasons.push("operational body contains an armed transition");
  } else if (mutation.test(source)) {
    classification = "mutating";
    reasons.push("operational body contains direct mutation");
  } else if (READ_ONLY_JUST_RECIPES.has(recipe)) {
    classification = "observe";
    reasons.push("audited read-only operational recipe");
  } else if (QUALITY_JUST_RECIPES.has(recipe) && /(?:cargo\s+(?:check|clippy|test|nextest)|validate|verify|audit|gate|check)/i.test(source)) {
    classification = "quality";
    reasons.push("audited quality recipe with verification body");
  } else if (OPS_JUST_RECIPES.has(recipe) && /(?:receipt|evidence|--write)/i.test(source)) {
    classification = "ops";
    reasons.push("audited receipt/evidence recipe");
  } else {
    reasons.push("no operational safe-run proof; fail closed");
  }

  const binary = latticeBinary(cwd);
  const preview = existsSync(binary) ? execOptional(binary, ["just", "classify", recipe], cwd, 20_000) : null;
  return { class: classification, reasons, source: "operational_harness", loomLatticePreview: preview?.ok ? preview.stdout.trim() : null };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function parseMaybeJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

export function registerHabitatSynergyTools(pi: PiApi): void {
  pi.registerTool({
    name: "habitat_power_inventory",
    label: "Habitat Power Inventory",
    description: "Read-only inventory of high-leverage Habitat surfaces: just recipes, Zellij panes/plugins, cc-pipe channels, runbook counts, and live service health.",
    promptSnippet: "Inventory Habitat justfile, Zellij, runbook, comms, and service power surfaces",
    promptGuidelines: ["Use habitat_power_inventory before choosing how to leverage the Habitat factory, Zellij panes, runbooks, or live services."],
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }): Promise<ToolResult> {
      const cwd = workspaceRootFor(ctx.cwd);
      const justDump = execOptional("just", ["--dump", "--dump-format", "json"], cwd, 15_000);
      const zellijTabs = commandOutput("zellij", ["action", "list-tabs"], cwd) ?? "";
      const zellijPanes = commandOutput("zellij", ["action", "list-panes"], cwd) ?? "";
      const ccPipe = execOptional("bin/cc-pipe", ["list"], cwd, 10_000);
      const services = await Promise.all(Object.entries(LIVE_ENDPOINTS).map(async ([name, endpoint]) => ({ name, endpoint, probe: await probeHttp(endpoint.port, endpoint.path) })));
      const recipes = justDump.ok ? Object.keys((JSON.parse(justDump.stdout) as { recipes: Record<string, unknown> }).recipes).sort() : [];
      const details = {
        just: { ok: justDump.ok, recipeCount: recipes.length, readOnlyAllowlist: [...READ_ONLY_JUST_RECIPES].sort(), confirmedWriteRunner: "habitat_just_run", recipes },
        zellij: { tabs: zellijTabs.split("\n").filter(Boolean), panes: zellijPanes.split("\n").filter(Boolean) },
        comms: { ok: ccPipe.ok, output: ccPipe.stdout || ccPipe.stderr },
        runbooks: { roots: RUNBOOK_ROOTS, searchTool: "habitat_runbook_search", readTool: "habitat_runbook_read", sample: collectRunbooks(cwd, "runbook", 20) },
        fabric: { transformTool: "habitat_fabric_transform", liveCallConfirmationRequired: true, outputWriteMode: "package_scoped_confirmed_write" },
        services: { total: services.length, healthy: services.filter((service) => service.probe.ok).length, probes: services },
      };
      return { content: [{ type: "text", text: truncate(JSON.stringify(details, null, 2)) }], details };
    },
  });

  pi.registerTool({
    name: "habitat_just_run",
    label: "Habitat Just Run",
    description: "Run a current operational Just recipe only after its body and audited policy classify it as observe, quality, or ops. Mutating, armed, and unknown recipes fail closed; LoomLattice is advisory only while WIP.",
    promptSnippet: "Run body-classified Justfile observe, quality, or ops recipes with receipt evidence",
    promptGuidelines: ["Classification inspects the current operational recipe body plus an audited policy set.", "Mutating, armed, and unknown classes require an authority plane this tool does not own and are always refused.", "LoomLattice preview output may reveal drift but never grants authority while that subsystem is WIP."],
    parameters: Type.Object({
      recipe: Type.String({ description: "Just recipe name" }),
      args: Type.Optional(Type.Array(Type.String(), { description: "Arguments passed without shell evaluation" })),
      confirmWrite: Type.Optional(Type.Boolean({ description: "Records explicit operator intent for quality/ops recipes; never admits mutating/armed/unknown" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Default 120000, max 600000" })),
    }),
    async execute(_toolCallId: string, params: { recipe: string; args?: string[]; confirmWrite?: boolean; timeoutMs?: number }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }): Promise<ToolResult> {
      const cwd = workspaceRootFor(ctx.cwd);
      const source = execOptional("just", ["--show", params.recipe], cwd, 15_000);
      if (!source.ok) throw new Error(`unable to inspect just recipe ${params.recipe}: ${source.stderr || source.stdout}`);
      if ((params.args ?? []).some((arg) => /[\r\n\0]/.test(arg))) throw new Error("just arguments containing control characters are refused");
      const llJust = classifyJustRecipe(cwd, params.recipe, source.stdout);
      if (!(["observe", "quality", "ops"] as const).includes(llJust.class as "observe" | "quality" | "ops")) {
        throw new Error(`just recipe refused by ll-just class=${llJust.class}: ${llJust.reasons.join("; ")}`);
      }
      const readOnly = llJust.class === "observe" || READ_ONLY_JUST_RECIPES.has(params.recipe);
      const declaredPermissions = readOnly ? ["read"] : ["read", "workspace_write"];
      const safety = classifyPermission({ cwd, objective: `run just recipe ${params.recipe}`, command: `just ${params.recipe} ${(params.args ?? []).join(" ")}\n${source.stdout}`, declaredPermissions });
      if (safety.class === "BLOCK" || safety.class === "GATE") throw new Error(`just recipe refused (${safety.class}): ${safety.reason}`);
      if (!readOnly && params.confirmWrite !== true) throw new Error(`just ${llJust.class} recipe ${params.recipe} requires confirmWrite=true`);

      const timeout = Math.min(Math.max(params.timeoutMs ?? 120_000, 1_000), 600_000);
      const result = execOptional("just", [params.recipe, ...(params.args ?? [])], cwd, timeout);
      const envelope = createBaseEnvelope({
        cwd,
        objective: `Habitat Just recipe ${params.recipe}`,
        kind: "factory_route",
        verdict: result.ok ? "pass" : "fail",
        safety: { ...safety, observedEffects: readOnly ? [] : [`just:${params.recipe}`], permissionDelta: readOnly ? "none" : "expected" },
      });
      const receipt = await appendReceipt(cwd, envelope);
      const details = { recipe: params.recipe, args: params.args ?? [], llJust, readOnly, safety, ok: result.ok, code: result.code, parsed: parseMaybeJson(result.stdout || result.stderr), stdout: result.stdout, stderr: result.stderr, receipt: { path: receipt.path, eventHash: receipt.eventHash, verified: receipt.verified } };
      return { content: [{ type: "text", text: truncate(JSON.stringify(details, null, 2)) }], details };
    },
  });

  pi.registerTool({
    name: "habitat_just_probe",
    label: "Habitat Just Probe",
    description: "Run an allowlisted read-only Habitat just recipe or show its source. Nonzero exits are returned as evidence, not hidden. Mutating/armed recipes are refused.",
    promptSnippet: "Run read-only Habitat just recipes such as sweep, tensor, factory-status-json, factory-wiring-json, loom-templates, comms-channels",
    promptGuidelines: ["Use habitat_just_probe for read-only justfile front-door operations; do not use it for deploy, ship, push, or arming recipes."],
    parameters: Type.Object({
      recipe: Type.String({ description: "Read-only allowlisted recipe name" }),
      args: Type.Optional(Type.Array(Type.String(), { description: "Recipe args" })),
      showOnly: Type.Optional(Type.Boolean({ description: "Show recipe source instead of running it", default: false })),
    }),
    async execute(_toolCallId: string, params: { recipe: string; args?: string[]; showOnly?: boolean }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }): Promise<ToolResult> {
      const cwd = workspaceRootFor(ctx.cwd);
      if (!READ_ONLY_JUST_RECIPES.has(params.recipe)) {
        throw new Error(`just recipe refused (not read-only allowlisted): ${params.recipe}`);
      }
      const args = params.showOnly ? ["--show", params.recipe] : [params.recipe, ...(params.args ?? [])];
      const result = execOptional("just", args, cwd, 60_000);
      const combined = result.stdout || result.stderr || "";
      const details = { recipe: params.recipe, args: params.args ?? [], showOnly: params.showOnly === true, ok: result.ok, code: result.code, parsed: parseMaybeJson(combined), stdout: result.stdout, stderr: result.stderr };
      return { content: [{ type: "text", text: truncate(JSON.stringify(details, null, 2)) }], details };
    },
  });

  pi.registerTool({
    name: "habitat_runbook_read",
    label: "Habitat Runbook Read",
    description: "Read one Markdown or typed TOML runbook from the source-indexed Habitat roots. Does not execute steps or cross an arming/HALT boundary.",
    promptSnippet: "Read a selected Habitat runbook in full before executing terminal steps",
    promptGuidelines: ["Search first, then read the exact source. Treat HALT, rollback, authority, and arming clauses as executable boundaries."],
    parameters: Type.Object({ path: Type.String({ description: "Workspace-relative Markdown path returned by habitat_runbook_search" }) }),
    async execute(_toolCallId: string, params: { path: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }): Promise<ToolResult> {
      const cwd = workspaceRootFor(ctx.cwd);
      const runbook = readRunbook(cwd, params.path);
      const details = { path: runbook.path, title: runbook.title, format: runbook.format, text: runbook.text };
      return { content: [{ type: "text", text: truncate(JSON.stringify(details, null, 2)) }], details };
    },
  });

  pi.registerTool({
    name: "habitat_runbook_validate",
    label: "Habitat Runbook Validate",
    description: "Preview-validate a WIP LoomLattice TOML runbook through GATE-RB-01..05. This is deployment-phase evidence, not an operational authority or live actuation path.",
    promptSnippet: "Validate a typed runbook FSM through the sealed GATE-RB contract",
    promptGuidelines: ["Use only for ids under loom-lattice-habitat/runbooks.", "A green validation proves contract completeness, not authorization to execute external actions."],
    parameters: Type.Object({ id: Type.String({ description: "Typed runbook id, for example stack-recover" }) }),
    async execute(_toolCallId: string, params: { id: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }): Promise<ToolResult> {
      const cwd = workspaceRootFor(ctx.cwd);
      if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(params.id)) throw new Error(`invalid runbook id: ${params.id}`);
      const binary = latticeBinary(cwd);
      if (!existsSync(binary)) throw new Error(`sealed ll-runbook validator unavailable: ${relative(cwd, binary)}`);
      const roots = join(cwd, "loom-lattice-habitat", "runbooks");
      const result = execOptional(binary, ["runbook", "validate", params.id, "--roots", roots], cwd, 30_000);
      const details = { id: params.id, roots: relative(cwd, roots), maturity: "wip_deployment_preview", operationalAuthority: false, ok: result.ok, code: result.code, stdout: result.stdout, stderr: result.stderr, liveActuation: false };
      return { content: [{ type: "text", text: truncate(JSON.stringify(details, null, 2)) }], details };
    },
  });

  pi.registerTool({
    name: "habitat_fabric_transform",
    label: "Habitat Fabric Transform",
    description: "Run an installed Fabric pattern with stdin text. Defaults to --dry-run; a live model call requires allowLiveCall=true. Optional output is written through the package-scoped hash-and-receipt path.",
    promptSnippet: "Use Fabric as an advisory text transformation substrate with explicit live-call and output-write confirmation",
    promptGuidelines: ["Fabric output is advisory and never authorizes execution.", "Do not use URL, YouTube, search, server, session-wipe, or pattern-update routes through this tool."],
    parameters: Type.Object({
      pattern: Type.String({ description: "Installed Fabric pattern name" }),
      input: Type.String({ description: "Text supplied over stdin" }),
      allowLiveCall: Type.Optional(Type.Boolean({ description: "Default false uses --dry-run" })),
      outputPath: Type.Optional(Type.String({ description: "Optional path relative to pi-codex-habitat-harness package root" })),
      confirmWrite: Type.Optional(Type.Boolean({ description: "Required when outputPath is set" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Default 120000, max 300000" })),
    }),
    async execute(_toolCallId: string, params: { pattern: string; input: string; allowLiveCall?: boolean; outputPath?: string; confirmWrite?: boolean; timeoutMs?: number }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }): Promise<ToolResult> {
      const cwd = workspaceRootFor(ctx.cwd);
      const patterns = execOptional("fabric", ["--listpatterns"], cwd, 20_000);
      const installed = new Set(patterns.stdout.split("\n").map((line) => line.trim()).filter(Boolean));
      if (!patterns.ok || !installed.has(params.pattern)) throw new Error(`Fabric pattern unavailable: ${params.pattern}`);
      if (params.outputPath && params.confirmWrite !== true) throw new Error("Fabric outputPath requires confirmWrite=true");
      const live = params.allowLiveCall === true;
      if (params.outputPath && !live) throw new Error("Fabric dry-run mints no output artifact or receipt; set allowLiveCall=true to save a real result");
      const patternSource = execOptional("fabric", ["--readpattern", params.pattern], cwd, 20_000);
      if (!patternSource.ok || !patternSource.stdout.trim()) throw new Error(`unable to read Fabric pattern source: ${params.pattern}`);
      const provenance = { class: "advisory", patternSha256: sha256(patternSource.stdout), inputSha256: sha256(params.input), patternSource: "fabric --readpattern" };
      const safety = classifyPermission({ cwd, objective: `Fabric pattern ${params.pattern}`, command: `fabric --pattern ${params.pattern}${live ? "" : " --dry-run"}`, declaredPermissions: live ? ["read", "network"] : ["read"] });
      if (safety.class === "BLOCK" || safety.class === "GATE") throw new Error(`Fabric transform refused (${safety.class}): ${safety.reason}`);
      const timeout = Math.min(Math.max(params.timeoutMs ?? 120_000, 1_000), 300_000);
      const args = ["--pattern", params.pattern, ...(live ? [] : ["--dry-run"])];
      const result = execOptional("fabric", args, cwd, timeout, params.input);
      let written = null;
      if (params.outputPath && result.ok) written = await scopedWrite({ cwd, relativePath: params.outputPath, content: result.stdout, confirmWrite: true });
      const details = { pattern: params.pattern, live, safety, provenance: { ...provenance, outputSha256: result.ok ? sha256(result.stdout) : null }, ok: result.ok, code: result.code, stdout: result.stdout, stderr: result.stderr, written };
      return { content: [{ type: "text", text: truncate(JSON.stringify(details, null, 2)) }], details };
    },
  });

  pi.registerTool({
    name: "habitat_runbook_search",
    label: "Habitat Runbook Search",
    description: "Search high-value Habitat runbook roots for operational FSMs, arming gates, rollback procedures, and source anchors. Read-only.",
    promptSnippet: "Search Habitat runbooks and operational docs for bounded procedures and arming gates",
    promptGuidelines: ["Use habitat_runbook_search before following or citing a runbook; respect HALT/Luke/arming gates found in the result."],
    parameters: Type.Object({
      query: Type.String({ description: "Case-insensitive substring to search" }),
      limit: Type.Optional(Type.Number({ description: "Max files, default 20" })),
    }),
    async execute(_toolCallId: string, params: { query: string; limit?: number }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }): Promise<ToolResult> {
      const cwd = workspaceRootFor(ctx.cwd);
      const matches = collectRunbooks(cwd, params.query, Math.min(Math.max(params.limit ?? 20, 1), 80));
      const details = { query: params.query, count: matches.length, matches };
      return { content: [{ type: "text", text: truncate(JSON.stringify(details, null, 2)) }], details };
    },
  });

  pi.registerTool({
    name: "habitat_live_probe",
    label: "Habitat Live Probe",
    description: "Probe allowlisted live Habitat HTTP health/status endpoints with GET only. No POST, no restart, no arming.",
    promptSnippet: "Probe selected Habitat live services over read-only GET endpoints",
    promptGuidelines: ["Use habitat_live_probe for service liveness before invoking factory, WFE, LCM, PV2, SYNTHEX, or memory workflows."],
    parameters: Type.Object({
      services: Type.Optional(Type.Array(Type.String({ enum: Object.keys(LIVE_ENDPOINTS) }), { description: "Endpoint names; omitted means all" })),
    }),
    async execute(_toolCallId: string, params: { services?: LiveEndpointName[] }): Promise<ToolResult> {
      const names = params.services && params.services.length > 0 ? params.services : Object.keys(LIVE_ENDPOINTS) as LiveEndpointName[];
      const probes = await Promise.all(names.map(async (name) => {
        const endpoint = LIVE_ENDPOINTS[name];
        return { name, endpoint, probe: await probeHttp(endpoint.port, endpoint.path) };
      }));
      const details = { total: probes.length, healthy: probes.filter((probe) => probe.probe.ok).length, probes };
      return { content: [{ type: "text", text: truncate(JSON.stringify(details, null, 2)) }], details };
    },
  });
}
