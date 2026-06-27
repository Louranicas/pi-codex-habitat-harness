import { Type } from "typebox";
import { appendReceipt } from "./codex-receipts.js";
import { classifyPermission } from "./codex-safety-membrane.js";
import { ddfStatus, reviewPatch, writeDdfArtifact } from "./deep-diff-forge-review.js";
import { createBaseEnvelope } from "./run-envelope.js";
import { harnessStatus } from "./status.js";

type PiApi = {
  registerCommand: (name: string, options: { description: string; handler: (args: string, ctx: { cwd: string; ui: { notify: (message: string, level?: string) => void; setStatus?: (key: string, value?: string) => void } }) => Promise<void> | void }) => void;
  registerTool: (definition: Record<string, unknown>) => void;
};

const OptionalString = Type.Optional(Type.String());

export default function codexPiHarnessExtension(pi: PiApi) {
  pi.registerCommand("codex-harness-status", {
    description: "Show Codex Pi Harness S1008820 offline judge-spine status",
    handler: async (_args, ctx) => {
      const status = await harnessStatus(ctx.cwd);
      const summary = `Codex Harness ${status.status}; identity=${status.identity.ok ? "ok" : "refused"}; ddf=${status.ddf.engineState}; receipts=${status.receiptLedger.count}`;
      ctx.ui.setStatus?.("codex-harness", summary);
      ctx.ui.notify(summary, status.identity.ok ? "info" : "warning");
    },
  });

  pi.registerTool({
    name: "codex_harness_status",
    label: "Codex Harness Status",
    description: "Return S1008820 Codex Pi Harness package identity, versions, receipt ledger, auth, and DDF status. Read-only.",
    promptSnippet: "Inspect Codex Pi Harness S1008820 local status without mutating the workspace.",
    promptGuidelines: ["Use codex_harness_status before claiming any S1008820 harness implementation gate status."],
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }) {
      const status = await harnessStatus(ctx.cwd);
      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
        details: status,
      };
    },
  });

  pi.registerTool({
    name: "codex_permission_classify",
    label: "Codex Permission Classify",
    description: "Classify a Codex/Agents/Fabric/Zellij/DDF action under the S1008820 safety membrane. Read-only.",
    promptSnippet: "Classify S1008820 harness actions as AUTO, DEFER, GATE, or BLOCK before execution.",
    promptGuidelines: ["Use codex_permission_classify before any Codex harness action that may mutate files, dispatch, deploy, start daemons, or call live services."],
    parameters: Type.Object({
      objective: Type.String({ description: "Action objective to classify" }),
      command: OptionalString,
      path: OptionalString,
      declaredPermissions: Type.Optional(Type.Array(Type.String())),
      observedEffects: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_toolCallId: string, params: { objective: string; command?: string; path?: string; declaredPermissions?: string[]; observedEffects?: string[] }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }) {
      const classification = classifyPermission({ ...params, cwd: ctx.cwd });
      return {
        content: [{ type: "text", text: JSON.stringify(classification, null, 2) }],
        details: classification,
      };
    },
  });

  pi.registerTool({
    name: "codex_receipt_write",
    label: "Codex Receipt Write",
    description: "Write a local-only S1008820 RunEnvelope receipt with hash-chain and redaction. Mutates only .pi/codex-harness/receipts.",
    promptSnippet: "Write local-only Codex Harness receipts after offline status, safety, or DDF review events.",
    promptGuidelines: ["Use codex_receipt_write only for local_file receipts; it must not be used to claim habitat_observed or factory_integrated circulation."],
    parameters: Type.Object({
      objective: Type.String(),
      verdict: Type.Optional(Type.String({ enum: ["pass", "fail", "partial", "skipped", "unknown"] })),
    }),
    async execute(_toolCallId: string, params: { objective: string; verdict?: "pass" | "fail" | "partial" | "skipped" | "unknown" }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }) {
      const envelope = createBaseEnvelope({ cwd: ctx.cwd, objective: params.objective, verdict: params.verdict ?? "unknown" });
      const written = await appendReceipt(ctx.cwd, envelope);
      return {
        content: [{ type: "text", text: `receipt=${written.path}\neventHash=${written.eventHash}\nverified=${written.verified}` }],
        details: written,
      };
    },
  });

  pi.registerTool({
    name: "ddf_status",
    label: "DDF Status",
    description: "Run allowed Deep-Diff-Forge status probes: version, self-test, deploy status JSON, and dirty-state classification. Does not start daemon or mutate git.",
    promptSnippet: "Inspect Deep-Diff-Forge engine availability for S1008820 GATE-20.",
    promptGuidelines: ["Use ddf_status before any ddf_review_patch claim; dirty engine availability is not gate-green."],
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }) {
      const status = ddfStatus(ctx.cwd);
      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
        details: status,
      };
    },
  });

  pi.registerTool({
    name: "ddf_review_patch",
    label: "DDF Review Patch",
    description: "Review, rank, or cluster a supplied unified patch through Deep-Diff-Forge one-shot stdin JSON mode. Preserves patch truth and writes local artifacts/receipt.",
    promptSnippet: "Send fixture or model-produced diffs to Deep-Diff-Forge review/rank/cluster before implementation claims.",
    promptGuidelines: ["Use ddf_review_patch on Codex/Agents-produced diffs before claiming workspace-write implementation success."],
    parameters: Type.Object({
      patch: Type.String({ description: "Unified/Git patch text" }),
      mode: Type.String({ enum: ["review", "rank", "cluster"], description: "DDF mode" }),
    }),
    async execute(_toolCallId: string, params: { patch: string; mode: "review" | "rank" | "cluster" }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }) {
      const result = reviewPatch(ctx.cwd, params.patch, params.mode);
      const artifact = await writeDdfArtifact(ctx.cwd, result);
      const envelope = createBaseEnvelope({
        cwd: ctx.cwd,
        objective: `DDF ${params.mode} patch review`,
        kind: "review",
        verdict: result.exitCode === 0 ? "pass" : "fail",
        safety: { class: "AUTO", reason: "DDF one-shot stdin review; no patch or git mutation", declaredPermissions: ["read"], observedEffects: [], permissionDelta: "none" },
      });
      envelope.deepDiffForge = {
        version: ddfStatus(ctx.cwd).version,
        engineState: ddfStatus(ctx.cwd).engineState,
        reviewSchema: result.schema,
        riskSummary: result.schema ? `${params.mode}:${result.schema}` : result.typedFailure ?? "unknown_failure",
        patchTruthPreserved: true,
      };
      envelope.artifacts.push(artifact);
      const receipt = await appendReceipt(ctx.cwd, envelope);
      return {
        content: [{ type: "text", text: JSON.stringify({ result, artifact, receipt: { path: receipt.path, eventHash: receipt.eventHash, verified: receipt.verified } }, null, 2) }],
        details: { result, artifact, receipt },
      };
    },
  });
}
