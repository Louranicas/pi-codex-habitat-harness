import { Type } from "typebox";
import { appendReceipt, writeJsonArtifact } from "./codex-receipts.js";
import { classifyPermission } from "./codex-safety-membrane.js";
import { ddfStatus, reviewPatch, writeDdfArtifact } from "./deep-diff-forge-review.js";
import { circulateReceiptToPovm } from "./external-circulation.js";
import { observeHabitat } from "./habitat-observation.js";
import { createBaseEnvelope } from "./run-envelope.js";
import { harnessStatus } from "./status.js";
import { scopedWrite } from "./write-capacity.js";
import { registerCodexFirstClassTools } from "./codex-first-class-tools.js";
import { registerHabitatSynergyTools } from "./habitat-synergy-tools.js";
import { registerCodexLoomTools } from "./codex-loom-tools.js";
import { registerTerminalSafety } from "./terminal-safety.js";
import { registerBrowserTools } from "./browser-tools.js";

type PiApi = {
  on?: (event: "tool_call", handler: (event: { toolName?: string; input?: Record<string, unknown> }, ctx: { cwd: string }) => Promise<{ block: true; reason: string } | undefined>) => void;
  registerCommand: (name: string, options: { description: string; handler: (args: string, ctx: { cwd: string; isIdle?: () => boolean; ui: { notify: (message: string, level?: string) => void; setStatus?: (key: string, value?: string) => void } }) => Promise<void> | void }) => void;
  registerTool: (definition: Record<string, unknown>) => void;
  sendUserMessage?: (message: string, options?: { deliverAs: "steer" | "followUp" }) => void;
};

const OptionalString = Type.Optional(Type.String());

export default function codexPiHarnessExtension(pi: PiApi) {
  pi.on?.("tool_call", async (event) => {
    if (event.toolName !== "save_session" && event.toolName !== "save_verify") return undefined;
    return {
      block: true,
      reason: `Legacy ${event.toolName} is disabled because it writes retired or unverified substrates. Use /save-session.`,
    };
  });

  registerTerminalSafety(pi);
  registerCodexFirstClassTools(pi);
  registerHabitatSynergyTools(pi);
  registerCodexLoomTools(pi);
  registerBrowserTools(pi);

  pi.registerCommand("codex-harness-status", {
    description: "Show Codex Pi Harness S1008820 offline judge-spine status",
    handler: async (_args, ctx) => {
      const status = await harnessStatus(ctx.cwd);
      const summary = `Codex Harness ${status.status}; identity=${status.identity.ok ? "ok" : "refused"}; substrate=${status.substrateClass}; ddf=${status.ddf.engineState}; receipts=${status.receiptLedger.count}`;
      ctx.ui.setStatus?.("codex-harness", summary);
      ctx.ui.notify(summary, status.identity.ok ? "info" : "warning");
    },
  });

  pi.registerCommand("save-session", {
    description: "Save the current session through the verified Habitat checkpoint skill",
    handler: async (args, ctx) => {
      if (!pi.sendUserMessage) {
        ctx.ui.notify("Save-session dispatch unavailable; use /skill:save-session", "warning");
        return;
      }
      const supplied = args.trim();
      const fieldDirective = supplied
        ? `User-supplied checkpoint fields (authoritative; derive only omissions): ${supplied}`
        : "No checkpoint fields were supplied. Zenguard has carriage: derive all five fields from the current conversation and fresh canonical checkpoint state, do not ask the operator to complete a form, and stop before writes only if a unique next session identity cannot be proven.";
      const prompt = [
        "/skill:save-session",
        "The user explicitly requests a session checkpoint. Follow the skill's intent gate, Zenguard carriage contract, substrate separation, migration guards, and fresh read-back receipt requirements.",
        "Do not call the legacy global save_session or save_verify tools.",
        "Interpret pipe-separated fields as: session number | one-line summary | key findings | next-session priorities | Ember reflection.",
        fieldDirective,
      ].join("\n\n");
      if (ctx.isIdle?.() === false) {
        pi.sendUserMessage(prompt, { deliverAs: "followUp" });
        ctx.ui.notify("Verified save-session checkpoint queued", "info");
        return;
      }
      pi.sendUserMessage(prompt);
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
    name: "codex_habitat_observe",
    label: "Codex Habitat Observe",
    description: "Probe Habitat-observed Codex Harness surfaces: live services, Zellij read-only routes, loom routes, Justfile, runbooks, Fabric, and DDF. Optionally writes a receipt.",
    promptSnippet: "Build or verify S1008820 Habitat-observed MVP surfaces without deploy/push/ship/factory arming.",
    promptGuidelines: ["Use before claiming Habitat-observed MVP; this is read-only except the optional local receipt/artifact write."],
    parameters: Type.Object({
      writeReceipt: Type.Optional(Type.Boolean({ description: "Write a local receipt and JSON observation artifact", default: true })),
      circulateExternal: Type.Optional(Type.Boolean({ description: "Also write an external POVM ACK receipt", default: false })),
    }),
    async execute(_toolCallId: string, params: { writeReceipt?: boolean; circulateExternal?: boolean }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }) {
      const observation = await observeHabitat(ctx.cwd);
      if (params.writeReceipt === false) {
        return { content: [{ type: "text", text: JSON.stringify(observation, null, 2) }], details: observation };
      }
      const artifact = await writeJsonArtifact(ctx.cwd, `habitat-observations/habitat-observation-${Date.now()}.json`, observation);
      const envelope = createBaseEnvelope({
        cwd: ctx.cwd,
        objective: "Habitat-observed Codex Harness surface probe",
        kind: "factory_route",
        verdict: observation.substrateClass === "habitat_observed" ? "partial" : "skipped",
        safety: { class: "AUTO", reason: "read-only habitat probes plus local receipt/artifact write", declaredPermissions: ["read", "local_file_write"], observedEffects: [artifact.path], permissionDelta: "expected" },
      });
      envelope.substrateClass = observation.substrateClass;
      envelope.receiptCirculationClass = "local_file";
      envelope.zellij = observation.zellij;
      envelope.liveServices = observation.liveServices;
      envelope.looms = observation.looms;
      envelope.justfile = observation.justfile;
      envelope.runbook = observation.runbook;
      envelope.fabric = observation.fabric;
      envelope.deepDiffForge = observation.deepDiffForge;
      envelope.artifacts.push(artifact);
      const receipt = await appendReceipt(ctx.cwd, envelope);
      let externalAck = null;
      let externalReceipt = null;
      if (params.circulateExternal === true) {
        externalAck = await circulateReceiptToPovm(receipt.eventHash, observation);
        const ackArtifact = await writeJsonArtifact(ctx.cwd, `habitat-observations/povm-ack-${Date.now()}.json`, externalAck);
        const ackEnvelope = createBaseEnvelope({
          cwd: ctx.cwd,
          objective: "Habitat-observed Codex Harness external receipt circulation",
          kind: "factory_route",
          verdict: externalAck.ok ? "pass" : "partial",
          safety: { class: "AUTO", reason: "single approved POVM memory ACK write", declaredPermissions: ["read", "local_file_write", "povm_memory_write"], observedEffects: [ackArtifact.path, externalAck.id ?? "povm_ack_failed"], permissionDelta: "expected" },
        });
        ackEnvelope.substrateClass = "habitat_observed";
        ackEnvelope.receiptCirculationClass = externalAck.ok ? "habitat_observed" : "local_file";
        ackEnvelope.liveServices = observation.liveServices;
        ackEnvelope.artifacts.push(ackArtifact);
        ackEnvelope.receipts.push({ path: receipt.path, id: receipt.eventHash });
        externalReceipt = await appendReceipt(ctx.cwd, ackEnvelope);
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ observation, artifact, receipt: { path: receipt.path, eventHash: receipt.eventHash, verified: receipt.verified }, externalAck, externalReceipt: externalReceipt ? { path: externalReceipt.path, eventHash: externalReceipt.eventHash, verified: externalReceipt.verified } : null }, null, 2) }],
        details: { observation, artifact, receipt, externalAck, externalReceipt },
      };
    },
  });

  pi.registerTool({
    name: "codex_scoped_write",
    label: "Codex Scoped Write",
    description: "Write a file under the pi-codex-habitat-harness package root only, with explicit confirmation, read-back verification, hash, and receipt. Never deploys, pushes, ships, writes factory authorization, starts DDF daemon, or serves Fabric.",
    promptSnippet: "Use codex_scoped_write for confirmed S1008820 package-scoped file writes after codex_permission_classify. No deploy/push/ship.",
    promptGuidelines: ["Set confirmWrite=true only when the user explicitly requested read-write capacity or a package-scoped edit.", "Do not use for .git, node_modules, dist, package-lock, deploy, push, ship, factory.authorize, DDF daemon, or Fabric server paths."],
    parameters: Type.Object({
      relativePath: Type.String({ description: "Path relative to pi-codex-habitat-harness package root" }),
      content: Type.String({ description: "Complete UTF-8 file content to write" }),
      confirmWrite: Type.Boolean({ description: "Must be true; proves explicit write confirmation" }),
    }),
    async execute(_toolCallId: string, params: { relativePath: string; content: string; confirmWrite: boolean }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }) {
      const result = await scopedWrite({ cwd: ctx.cwd, relativePath: params.relativePath, content: params.content, confirmWrite: params.confirmWrite });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "codex_receipt_write",
    label: "Codex Receipt Write",
    description: "Write a local-only S1008820 RunEnvelope receipt with hash-chain and redaction. Mutates only .pi/codex-harness/receipts.",
    promptSnippet: "Write local-only Codex Harness receipts after offline status, safety, or DDF review events.",
    promptGuidelines: ["Use codex_receipt_write only for local_file receipts; use codex_habitat_observe for Habitat-observed probe receipts."],
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
