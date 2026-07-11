import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThreadOptions, WebSearchMode } from "@openai/codex-sdk";
import { Type } from "typebox";
import { z } from "zod";
import { createTimeoutSignal } from "./abort-timeout.js";
import { PACKAGE_IDENTITY } from "./constants.js";
import { redactSecrets } from "./codex-receipts.js";
import { classifyPermission } from "./codex-safety-membrane.js";
import { ddfStatus } from "./deep-diff-forge-review.js";
import { resolveWorkspaceDirectory, workspaceRootFor } from "./package-identity.js";
import { RunEnvelopeSchema } from "./run-envelope.js";
import { SLoomModuleSchema, SLoomRosterManifestSchema } from "./s-loom-roster.js";
import { harnessStatus } from "./status.js";
import { observeWriteCapacity } from "./write-capacity.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; details?: unknown; terminate?: boolean };

type PiApi = {
  getAllTools?: () => Array<{ name: string; description?: string; sourceInfo?: unknown }>;
  registerTool: (definition: Record<string, unknown>) => void;
};

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";
const DEFAULT_CODEX_REASONING_EFFORT = "max" as const;

export type CodexHarnessAccessMode = "read_only" | "workspace_write";
export type CodexHarnessReasoningEffort = NonNullable<ThreadOptions["modelReasoningEffort"]> | "max";

export interface CodexRuntimeProfileInput {
  accessMode?: CodexHarnessAccessMode;
  confirmWorkspaceWrite?: boolean;
  confirmNetworkAccess?: boolean;
  model?: string;
  modelReasoningEffort?: CodexHarnessReasoningEffort;
  networkAccessEnabled?: boolean;
  webSearchMode?: WebSearchMode;
}

export function buildCodexRuntimeProfile(workingDirectory: string, input: CodexRuntimeProfileInput) {
  const accessMode = input.accessMode ?? "workspace_write";
  const networkAccessEnabled = input.networkAccessEnabled ?? false;
  const webSearchMode = input.webSearchMode ?? "disabled";
  const modelReasoningEffort = input.modelReasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT;

  if (accessMode === "workspace_write" && input.confirmWorkspaceWrite !== true) {
    throw new Error("workspace_write requires confirmWorkspaceWrite=true");
  }
  if ((networkAccessEnabled || webSearchMode === "live") && input.confirmNetworkAccess !== true) {
    throw new Error("live network or web search requires confirmNetworkAccess=true");
  }
  if (webSearchMode === "live" && !networkAccessEnabled) {
    throw new Error("webSearchMode=live requires networkAccessEnabled=true");
  }

  const threadOptions: ThreadOptions = {
    model: input.model ?? DEFAULT_CODEX_MODEL,
    sandboxMode: accessMode === "workspace_write" ? "workspace-write" : "read-only",
    workingDirectory,
    skipGitRepoCheck: true,
    approvalPolicy: "never",
    networkAccessEnabled,
    webSearchMode,
  };
  if (modelReasoningEffort !== "max") threadOptions.modelReasoningEffort = modelReasoningEffort;

  return {
    accessMode,
    modelReasoningEffort,
    clientConfig: { model_reasoning_effort: modelReasoningEffort },
    threadOptions,
  };
}

const PackageIdentitySchema = z.object({
  packageName: z.literal(PACKAGE_IDENTITY.packageName),
  packageRoot: z.literal(PACKAGE_IDENTITY.packageRoot),
  receiptNamespace: z.literal(PACKAGE_IDENTITY.receiptNamespace),
});

const PermissionClassificationSchema = z.object({
  class: z.enum(["AUTO", "DEFER", "GATE", "BLOCK"]),
  reason: z.string(),
  declaredPermissions: z.array(z.string()),
  observedEffects: z.array(z.string()),
  permissionDelta: z.enum(["none", "expected", "violation", "unknown"]),
});

const HarnessStatusSliceSchema = z.object({
  status: z.enum(["ready_full_read_write_capacity", "ready_full_readonly_capacity", "ready_habitat_observed", "ready_offline", "refused_identity"]),
  authState: z.enum(["present", "missing"]),
  substrateClass: z.enum(["local_only", "habitat_observed", "factory_integrated", "factory_armed"]),
  receiptCirculationClass: z.enum(["local_file", "habitat_observed", "factory_integrated"]),
});

const Sol56TaskResultSchema = z.object({
  status: z.enum(["ok", "action_required", "blocked"]),
  summary: z.string(),
  changedFiles: z.array(z.string()),
  commands: z.array(z.string()),
  verification: z.array(z.string()),
});

export const HARNESS_ZOD_SCHEMAS = {
  run_envelope_v2: RunEnvelopeSchema,
  package_identity: PackageIdentitySchema,
  permission_classification: PermissionClassificationSchema,
  harness_status_slice: HarnessStatusSliceSchema,
  sol56_task_result: Sol56TaskResultSchema,
  s_loom_roster_manifest: SLoomRosterManifestSchema,
  s_loom_module: SLoomModuleSchema,
} as const;

type SchemaName = keyof typeof HARNESS_ZOD_SCHEMAS;

function optionalPackageVersion(pkg: string): string | null {
  const directPath = join(packageRoot, "node_modules", ...pkg.split("/"), "package.json");
  try {
    const parsed = JSON.parse(readFileSync(directPath, "utf8")) as { version?: string };
    return parsed.version ?? null;
  } catch {
    try {
      return (require(`${pkg}/package.json`) as { version?: string }).version ?? null;
    } catch {
      return null;
    }
  }
}

function optionalCommand(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, { encoding: "utf8", timeout: 10_000 }).trim();
  } catch {
    return null;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function truncate(text: string, maxChars = 20_000): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]`;
}

function assertLiveAllowed(allowLiveCall: boolean | undefined, toolName: string): void {
  if (allowLiveCall !== true) {
    throw new Error(`${toolName} requires allowLiveCall=true; this prevents accidental OpenAI/Codex spend or live execution`);
  }
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(`${toolName} requires OPENAI_API_KEY`);
  }
}

export function registerCodexFirstClassTools(pi: PiApi): void {
  pi.registerTool({
    name: "codex_feature_inventory",
    label: "Codex Feature Inventory",
    description: "Inventory first-class Codex Harness capabilities: Zod schemas, Codex SDK/CLI, OpenAI Agents TS, registered Pi tools, DDF, write membrane, and hard stops. Read-only.",
    promptSnippet: "Inventory Codex Harness first-class features and dependency versions",
    promptGuidelines: ["Use codex_feature_inventory before claiming which Codex/Zod/Agents features are available as first-class tools."],
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }): Promise<ToolResult> {
      const workspace = workspaceRootFor(ctx.cwd);
      const status = await harnessStatus(workspace);
      const allTools = pi.getAllTools?.() ?? [];
      const details = {
        status: status.status,
        authState: status.authState,
        versions: {
          node: process.version,
          pi: optionalCommand("pi", ["--version"]),
          codexCli: optionalCommand("codex", ["--version"]),
          codexSdk: optionalPackageVersion("@openai/codex-sdk"),
          openaiAgentsTs: optionalPackageVersion("@openai/agents"),
          playwrightCli: optionalPackageVersion("@playwright/cli"),
          playwrightCore: optionalPackageVersion("playwright-core"),
          zod: optionalPackageVersion("zod"),
        },
        registeredHarnessTools: [
          "codex_harness_status",
          "codex_permission_classify",
          "codex_habitat_observe",
          "codex_scoped_write",
          "codex_receipt_write",
          "ddf_status",
          "ddf_review_patch",
          "codex_feature_inventory",
          "zod_validate_json",
          "codex_sdk_run",
          "openai_agents_ts_run",
          "habitat_power_inventory",
          "habitat_just_probe",
          "habitat_just_run",
          "habitat_runbook_search",
          "habitat_runbook_read",
          "habitat_runbook_validate",
          "habitat_fabric_transform",
          "habitat_live_probe",
          "habitat_loom_inventory",
          "habitat_loom_plan",
          "codex_s_loom_roster",
          "codex_s_lobe_plan",
          "codex_loom_cluster",
          "codex_browser_inventory",
          "codex_browser_evidence_seal",
        ],
        activePiToolsKnownToExtension: allTools.map((tool) => tool.name).sort(),
        sol56Runtime: {
          defaultModel: DEFAULT_CODEX_MODEL,
          defaultReasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
          defaultAccessMode: "workspace_write",
          workspaceWriteConfirmationRequired: true,
          networkConfirmationRequired: true,
          zodStructuredOutput: true,
          terminalFirst: true,
          mcpRequired: false,
          browserAutomation: "terminal_first_playwright_cli",
        },
        schemas: Object.keys(HARNESS_ZOD_SCHEMAS),
        ddf: ddfStatus(workspace),
        writeCapacity: observeWriteCapacity(workspace),
        hardStops: status.hardStops,
      };
      return { content: [{ type: "text", text: JSON.stringify(redactSecrets(details), null, 2) }], details };
    },
  });

  pi.registerTool({
    name: "zod_validate_json",
    label: "Zod Validate JSON",
    description: "Validate JSON text against built-in Codex Harness Zod schemas. Read-only. Includes the SOL 5.6 task-result contract.",
    promptSnippet: "Validate JSON against Codex Harness Zod schemas",
    promptGuidelines: ["Use zod_validate_json when validating Codex Harness receipts, package identity, safety classifications, or status slices."],
    parameters: Type.Object({
      schemaName: Type.String({ enum: Object.keys(HARNESS_ZOD_SCHEMAS), description: "Built-in Zod schema name" }),
      json: Type.String({ description: "JSON document to validate" }),
    }),
    async execute(_toolCallId: string, params: { schemaName: SchemaName; json: string }): Promise<ToolResult> {
      const schema = HARNESS_ZOD_SCHEMAS[params.schemaName];
      const value = parseJson(params.json);
      const parsed = schema.safeParse(value);
      const details = parsed.success
        ? { ok: true, schemaName: params.schemaName, value: parsed.data }
        : { ok: false, schemaName: params.schemaName, issues: parsed.error.issues };
      return { content: [{ type: "text", text: JSON.stringify(redactSecrets(details), null, 2) }], details };
    },
  });

  pi.registerTool({
    name: "codex_sdk_run",
    label: "Codex SDK Run",
    description: "Run a terminal-first gpt-5.6-sol Codex SDK turn with confirmation-gated workspace writes, optional confirmed network, and Zod-validated structured output. Never exposes danger-full-access.",
    promptSnippet: "Run a bounded SOL 5.6 Codex SDK turn with native terminal tools, workspace-write confirmation, and optional Zod output",
    promptGuidelines: [
      "Use codex_sdk_run for terminal-native Codex work that benefits from a nested SOL 5.6 coding turn.",
      "Set confirmWorkspaceWrite=true for workspace_write; writes remain workspace-confined and danger-full-access is unavailable.",
      "Network and live web search remain disabled unless confirmNetworkAccess=true is supplied explicitly.",
      "Use outputSchemaName=sol56_task_result for Zod-validated implementation summaries.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Prompt for Codex" }),
      allowLiveCall: Type.Boolean({ description: "Must be true to permit a live Codex SDK call" }),
      workingDirectory: Type.Optional(Type.String({ description: "Workspace-relative or absolute directory under the workspace" })),
      model: Type.Optional(Type.String({ description: `Optional Codex model id; defaults to ${DEFAULT_CODEX_MODEL}` })),
      modelReasoningEffort: Type.Optional(Type.String({ enum: ["minimal", "low", "medium", "high", "xhigh", "max"], description: `Codex reasoning effort; defaults to ${DEFAULT_CODEX_REASONING_EFFORT}` })),
      accessMode: Type.Optional(Type.String({ enum: ["read_only", "workspace_write"], description: "Defaults to workspace_write" })),
      confirmWorkspaceWrite: Type.Optional(Type.Boolean({ description: "Must be true when accessMode=workspace_write" })),
      networkAccessEnabled: Type.Optional(Type.Boolean({ description: "Default false" })),
      confirmNetworkAccess: Type.Optional(Type.Boolean({ description: "Must be true for live network or live web search" })),
      outputSchema: Type.Optional(Type.Any({ description: "Optional JSON schema for structured Codex output" })),
      outputSchemaName: Type.Optional(Type.String({ enum: Object.keys(HARNESS_ZOD_SCHEMAS), description: "Optional built-in Zod schema converted to JSON Schema and validated after the turn" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds, default 120000, max 300000" })),
      webSearchMode: Type.Optional(Type.String({ enum: ["disabled", "cached", "live"], description: "Default disabled" })),
    }),
    async execute(_toolCallId: string, params: { prompt: string; allowLiveCall?: boolean; workingDirectory?: string; model?: string; modelReasoningEffort?: CodexHarnessReasoningEffort; accessMode?: CodexHarnessAccessMode; confirmWorkspaceWrite?: boolean; networkAccessEnabled?: boolean; confirmNetworkAccess?: boolean; outputSchema?: unknown; outputSchemaName?: SchemaName; timeoutMs?: number; webSearchMode?: WebSearchMode }, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }): Promise<ToolResult> {
      assertLiveAllowed(params.allowLiveCall, "codex_sdk_run");
      const workspace = workspaceRootFor(ctx.cwd);
      const workingDirectory = resolveWorkspaceDirectory(ctx.cwd, params.workingDirectory);
      const timeoutMs = Math.min(Math.max(params.timeoutMs ?? 120_000, 1_000), 300_000);
      if (params.outputSchema && params.outputSchemaName) throw new Error("provide outputSchema or outputSchemaName, not both");
      const runtime = buildCodexRuntimeProfile(workingDirectory, params);
      const declaredPermissions = ["read", "live_openai_call"];
      if (runtime.accessMode === "workspace_write") declaredPermissions.push("workspace_write");
      if (runtime.threadOptions.networkAccessEnabled) declaredPermissions.push("network");
      const safety = classifyPermission({ cwd: workspace, objective: params.prompt, command: "Codex.startThread().run", declaredPermissions });
      if (safety.class === "BLOCK" || safety.class === "GATE") {
        throw new Error(`codex_sdk_run refused ${safety.class} prompt: ${safety.reason}`);
      }
      const selectedZodSchema = params.outputSchemaName ? HARNESS_ZOD_SCHEMAS[params.outputSchemaName] : null;
      const outputSchema = params.outputSchema ?? (selectedZodSchema ? z.toJSONSchema(selectedZodSchema) : undefined);
      const safetyPrefix = [
        "Codex Harness boundaries for this turn:",
        "- Work only inside the configured working directory.",
        "- Do not deploy, push, ship, publish, tag, modify .git internals, start daemons/servers, or bypass the sandbox.",
        "- Use terminal tools directly and verify any change you make.",
        "",
      ].join("\n");
      const { Codex } = await import("@openai/codex-sdk");
      const codex = new Codex({ config: runtime.clientConfig });
      const thread = codex.startThread(runtime.threadOptions);
      const timeout = createTimeoutSignal(signal, timeoutMs);
      const turn = await thread.run(`${safetyPrefix}${params.prompt}`, { outputSchema, signal: timeout.signal }).finally(timeout.dispose);
      let structuredOutput: unknown = null;
      if (selectedZodSchema) {
        try {
          const parsed = selectedZodSchema.safeParse(JSON.parse(turn.finalResponse));
          structuredOutput = parsed.success ? { ok: true, schemaName: params.outputSchemaName, value: parsed.data } : { ok: false, schemaName: params.outputSchemaName, issues: parsed.error.issues };
        } catch (error) {
          structuredOutput = { ok: false, schemaName: params.outputSchemaName, error: error instanceof Error ? error.message : String(error) };
        }
      }
      const details = redactSecrets({
        threadId: thread.id,
        finalResponse: turn.finalResponse,
        usage: turn.usage,
        itemTypes: turn.items.map((item) => item.type),
        items: turn.items.slice(-20),
        safety,
        runtime: { ...runtime, threadOptions: { ...runtime.threadOptions, workingDirectory } },
        structuredOutput,
      });
      return { content: [{ type: "text", text: truncate(JSON.stringify(details, null, 2)) }], details };
    },
  });

  pi.registerTool({
    name: "openai_agents_ts_run",
    label: "OpenAI Agents TS Run",
    description: "Run a live @openai/agents TypeScript Agent with no tools by default. Requires allowLiveCall=true. Use for first-class Agents SDK access without filesystem mutation.",
    promptSnippet: "Run a bounded live OpenAI Agents TypeScript Agent turn",
    promptGuidelines: [
      "Use openai_agents_ts_run only when the user explicitly asks for a live OpenAI Agents SDK run.",
      "openai_agents_ts_run creates a no-tool Agent by default; it should not be used for file mutation or deployment.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Prompt for the Agent" }),
      allowLiveCall: Type.Boolean({ description: "Must be true to permit a live OpenAI Agents SDK call" }),
      name: Type.Optional(Type.String({ description: "Agent name, default Harness Agent" })),
      instructions: Type.Optional(Type.String({ description: "Agent instructions" })),
      model: Type.Optional(Type.String({ description: "Optional model id" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds, default 120000, max 300000" })),
    }),
    async execute(_toolCallId: string, params: { prompt: string; allowLiveCall?: boolean; name?: string; instructions?: string; model?: string; timeoutMs?: number }, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }): Promise<ToolResult> {
      assertLiveAllowed(params.allowLiveCall, "openai_agents_ts_run");
      const workspace = workspaceRootFor(ctx.cwd);
      const timeoutMs = Math.min(Math.max(params.timeoutMs ?? 120_000, 1_000), 300_000);
      const safety = classifyPermission({ cwd: workspace, objective: "live OpenAI Agents TS no-tool run", command: "@openai/agents run", declaredPermissions: ["live_openai_call"] });
      const agentConfig: { name: string; instructions: string; model?: string } = {
        name: params.name ?? "Harness Agent",
        instructions: params.instructions ?? "You are a concise no-tool agent running inside the Codex Pi Harness. Do not claim filesystem access.",
      };
      if (params.model) agentConfig.model = params.model;
      const { Agent, run } = await import("@openai/agents");
      const agent = new Agent(agentConfig);
      const timeout = createTimeoutSignal(signal, timeoutMs);
      const result = await run(agent, params.prompt, { signal: timeout.signal }).finally(timeout.dispose);
      const details = redactSecrets({
        finalOutput: result.finalOutput,
        state: typeof result.state === "object" ? { currentTurn: result.state?._currentTurn } : undefined,
        safety,
        agent: { name: agentConfig.name, model: agentConfig.model ?? null },
      });
      return { content: [{ type: "text", text: truncate(JSON.stringify(details, null, 2)) }], details };
    },
  });
}
