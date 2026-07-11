import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTimeoutSignal } from "../extensions/abort-timeout.js";
import { checkPackageIdentity, resolveWorkspaceDirectory } from "../extensions/package-identity.js";
import { actorBridgeStatus } from "../extensions/actor-bridges.js";
import { appendReceipt, readLastReceiptCirculationClass, redactSecrets, strongestReceiptCirculationClass, verifyReceiptLedger } from "../extensions/codex-receipts.js";
import { classifyPermission } from "../extensions/codex-safety-membrane.js";
import { reviewPatch, ddfStatus } from "../extensions/deep-diff-forge-review.js";
import { observeHabitat } from "../extensions/habitat-observation.js";
import codexPiHarnessExtension from "../extensions/index.js";
import { createBaseEnvelope, RunEnvelopeSchema } from "../extensions/run-envelope.js";
import { observeWriteCapacity, scopedWrite } from "../extensions/write-capacity.js";
import { buildCodexRuntimeProfile, HARNESS_ZOD_SCHEMAS } from "../extensions/codex-first-class-tools.js";
import { loadSLoomRoster, resolveSLoomRole } from "../extensions/s-loom-roster.js";
import { createCacheBinding, digestSLoomLaneSeal, readSLoomCache, workspaceStateSha, writeSLoomCache } from "../extensions/s-loom-cache.js";
import { buildMacroJudgePrompt, buildSLobePlan, JudgeResultSchema, macroJudgePrimaryBudget, resolveClusterVerdict, validateJudgeDecision, validateJudgeDigestClassification, type JudgeSeal } from "../extensions/codex-loom-tools.js";
import { browserInventory, collectBrowserEvidence } from "../extensions/browser-tools.js";

const workspace = resolve("..");
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codex-harness-test-"));
  tempRoots.push(dir);
  const packageDir = join(dir, "pi-codex-habitat-harness");
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "pi-codex-habitat-harness" }, null, 2) + "\n", "utf8");
  return dir;
}

describe("S1008820 first-slice offline judge spine", () => {
  it("disposes successful-call timeout signals without a late abort", () => {
    vi.useFakeTimers();
    try {
      const timeout = createTimeoutSignal(undefined, 1_000);
      timeout.dispose();
      vi.advanceTimersByTime(1_000);
      expect(timeout.signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("loads the Pi extension entrypoint and registers first-slice commands/tools", () => {
    const commands: string[] = [];
    const tools: string[] = [];
    codexPiHarnessExtension({
      registerCommand: (name: string) => commands.push(name),
      registerTool: (definition: Record<string, unknown>) => tools.push(String(definition.name)),
    });
    expect(commands).toContain("codex-harness-status");
    expect(commands).toContain("save-session");
    expect(tools).toEqual(expect.arrayContaining(["codex_harness_status", "codex_habitat_observe", "codex_permission_classify", "codex_scoped_write", "codex_receipt_write", "ddf_status", "ddf_review_patch", "codex_feature_inventory", "zod_validate_json", "codex_sdk_run", "openai_agents_ts_run", "habitat_power_inventory", "habitat_just_probe", "habitat_just_run", "habitat_runbook_search", "habitat_runbook_read", "habitat_runbook_validate", "habitat_fabric_transform", "habitat_live_probe", "habitat_loom_inventory", "habitat_loom_plan", "codex_s_loom_roster", "codex_s_lobe_plan", "codex_loom_cluster", "codex_browser_inventory", "codex_browser_evidence_seal"]));
  });

  it("routes /save-session through the verified skill instead of the legacy broadcaster", async () => {
    let handler: ((args: string, ctx: { cwd: string; isIdle?: () => boolean; ui: { notify: (message: string, level?: string) => void } }) => Promise<void> | void) | undefined;
    let sent = "";
    codexPiHarnessExtension({
      registerCommand: (name, options) => {
        if (name === "save-session") handler = options.handler;
      },
      registerTool: () => undefined,
      sendUserMessage: (message) => { sent = message; },
    });
    expect(handler).toBeDefined();
    await handler!("101 | summary | finding | next | reflection", {
      cwd: workspace,
      isIdle: () => true,
      ui: { notify: () => undefined },
    });
    expect(sent).toContain("/skill:save-session");
    expect(sent).toContain("101 | summary | finding | next | reflection");
    expect(sent).toContain("Do not call the legacy global save_session or save_verify tools.");
  });

  it("blocks the legacy save broadcaster at the tool boundary", async () => {
    const handlers: Array<(event: { toolName?: string; input?: Record<string, unknown> }, ctx: { cwd: string }) => Promise<{ block: true; reason: string } | undefined>> = [];
    codexPiHarnessExtension({
      on: (_event, handler) => handlers.push(handler),
      registerCommand: () => undefined,
      registerTool: () => undefined,
    });
    const verdicts = await Promise.all(handlers.map((handler) => handler({ toolName: "save_session", input: {} }, { cwd: workspace })));
    expect(verdicts).toContainEqual(expect.objectContaining({ block: true, reason: expect.stringContaining("Use /save-session") }));
  });

  it("inventories the terminal-first browser plane without requiring MCP", () => {
    const inventory = browserInventory(workspace);
    expect(inventory.executionPlane).toBe("terminal_first_playwright_cli");
    expect(inventory.mcpRequired).toBe(false);
    expect(inventory.versions.playwrightCli).toBe("0.1.17");
    expect(inventory.safety.defaultProfile).toBe("isolated_ephemeral");
  });

  it("hashes only regular workspace-contained browser evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-harness-browser-evidence-"));
    const outside = await mkdtemp(join(tmpdir(), "codex-harness-browser-outside-"));
    tempRoots.push(root, outside);
    const evidence = join(root, "desktop.png");
    await writeFile(evidence, "browser pixels\n");
    const artifacts = await collectBrowserEvidence(root, ["desktop.png"]);
    expect(artifacts).toEqual([{ path: evidence, sha256: createHash("sha256").update("browser pixels\n").digest("hex"), bytes: 15 }]);
    await symlink(evidence, join(root, "linked.png"));
    await writeFile(join(outside, "outside.png"), "outside\n");
    await expect(collectBrowserEvidence(root, ["linked.png"])).rejects.toThrow(/symlink refused/);
    await expect(collectBrowserEvidence(root, [join(outside, "outside.png")])).rejects.toThrow(/outside workspace/);
  });

  it("loads the modular S Loom Roster and grounds every default persona", () => {
    const roster = loadSLoomRoster();
    expect(roster.name).toBe("S Loom Roster");
    expect(Object.keys(roster.looms)).toEqual(expect.arrayContaining(["review", "build", "debug", "architecture", "innovation", "harness", "observe"]));
    for (const [profile, loom] of Object.entries(roster.looms)) {
      expect(loom.roles.length).toBeGreaterThanOrEqual(3);
      expect(loom.roles.some((role) => role.id === loom.lobeSeat)).toBe(true);
      for (const role of loom.roles) {
        const resolved = resolveSLoomRole(workspace, profile, role);
        expect(resolved.personaGenome.id).toBe(role.persona.defaultPersona);
        expect(resolved.personaGenome.memory_scope.requires_provenance).toBe(true);
      }
    }
  });

  it("operationalizes the evidence-only observability and deployment benchmark loom", () => {
    const roster = loadSLoomRoster();
    const observe = roster.looms.observe!;
    expect(observe.id).toBe("s-observe-benchmark");
    expect(observe.clusterContract?.micro.map((loop) => loop.roleId)).toEqual(observe.roles.map((role) => role.id));
    expect(observe.clusterContract?.antiGoodhart).toContain("A deployment-readiness seal is not deployment authority.");
    expect(observe.ports.emits).toContain("deployment_readiness_seal");
    expect(observe.roles.every((role) => role.memory.negativeEdgeOnFailure === false)).toBe(true);
  });

  it("hot-swaps an S Loom persona only through a compatible fixed read-only seat", () => {
    const roster = loadSLoomRoster();
    const adversary = roster.looms.review?.roles.find((role) => role.id === "failure-adversary");
    expect(adversary).toBeDefined();
    const swapped = resolveSLoomRole(workspace, "review", adversary!, "metric-skeptic");
    expect(swapped.swapState).toBe("hot_swapped");
    expect(swapped.personaGenome.id).toBe("metric-skeptic");
    expect(() => resolveSLoomRole(workspace, "review", adversary!, "loomwright-genesis-agent")).toThrow(/incompatible|widen/);
  });

  it("composes S Loom modules into a typed micro-meso-macro lobe plan", () => {
    const roster = loadSLoomRoster();
    const profiles = ["review", "architecture", "harness"];
    const modules = profiles.map((profile) => roster.looms[profile]!);
    const roles = modules.map((loom) => resolveSLoomRole(workspace, loom.profile, loom.roles.find((role) => role.id === loom.lobeSeat)!));
    const plan = buildSLobePlan(roster, roles, modules, "audit the harness as a distributed lobe");
    expect(plan.sphere).toBe("stacked");
    expect(plan.micro).toHaveLength(3);
    expect(plan.meso).toHaveLength(3);
    expect(plan.macro.judgeBarrier).toBe("outside_context_same_model_family");
    expect(plan.geometry.sharedMedium).toBe("gyroid");
    expect(plan.transport.oneShotWorker).toBe("bounded_stdio_pipe");
  });

  it("bounds the macro judge to a compact seal-only execution envelope", () => {
    const roster = loadSLoomRoster();
    const profiles = ["review", "architecture", "harness"];
    const modules = profiles.map((profile) => roster.looms[profile]!);
    const roles = modules.map((loom) => resolveSLoomRole(workspace, loom.profile, loom.roles.find((role) => role.id === loom.lobeSeat)!));
    const objective = "adjudicate immutable evidence without repository exploration";
    const plan = buildSLobePlan(roster, roles, modules, objective);
    const judgeSeals: JudgeSeal[] = plan.micro.map((lane, index) => ({
      profile: lane.profile,
      moduleId: plan.meso.find((module) => module.profile === lane.profile)!.id,
      roleId: lane.roleId,
      personaId: lane.persona.id,
      persona: lane.persona,
      source: "live",
      digest: (index + 1).toString(16).repeat(64),
      seal: {
        role: lane.title,
        finding: `finding ${index + 1}`,
        evidence: [`test/harness.test.ts:${120 + index}`],
        risks: [],
        recommendation: `recommendation ${index + 1}`,
        confidence: 0.9,
      },
    }));
    const prompt = buildMacroJudgePrompt(objective, plan, judgeSeals);

    expect(macroJudgePrimaryBudget(480_000)).toBe(240_000);
    expect(prompt).toContain("Do not call terminal, filesystem, web, MCP, planning, todo, or any other tool.");
    expect(prompt).not.toContain("memoryNamespaces");
    expect(prompt).not.toContain("genomeSha256");
    expect(prompt.length).toBeLessThan(20_000);
    expect(JudgeResultSchema.safeParse({
      verdict: "proceed",
      synthesis: "bounded",
      conflicts: [],
      synergies: [],
      acceptedLaneDigests: Array.from({ length: 6 }, (_, index) => index.toString(16).repeat(64)),
      rejectedLaneDigests: [],
      plan: [],
      acceptanceCriteria: [],
    }).success).toBe(false);
  });

  it("round-trips judged S Loom role memory through the Habitat smart cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-harness-hsc-"));
    tempRoots.push(root);
    const previous = { hot: process.env.HSC_HOT_DIR, data: process.env.HSC_DATA_DIR, kv: process.env.HSC_KV_DISABLED };
    process.env.HSC_HOT_DIR = join(root, "hot");
    process.env.HSC_DATA_DIR = join(root, "data");
    process.env.HSC_KV_DISABLED = "1";
    try {
      await mkdir(join(root, "bin"));
      await symlink(join(workspace, "bin", "hsc"), join(root, "bin", "hsc"));
      const proofPath = join(root, "admission.json");
      const proofContent = "{\"verdict\":\"proceed\"}\n";
      await writeFile(proofPath, proofContent);
      const proofRef = `${proofPath}@sha256:${createHash("sha256").update(proofContent).digest("hex")}`;
      const roster = loadSLoomRoster();
      const loom = roster.looms.review!;
      const role = resolveSLoomRole(workspace, "review", loom.roles[0]!);
      const binding = createCacheBinding(loom, role, "cache roundtrip", join(workspace, "pi-codex-habitat-harness"), roster.manifestSha256, roster.moduleSha256.review!, "a".repeat(64));
      const value = { role: role.title, finding: "cache proof", evidence: ["test fixture"], risks: [], recommendation: "retain", confidence: 0.9 };
      const written = writeSLoomCache(root, binding, role, "judged_lane_seal", value, proofRef, "proceed", "refresh", digestSLoomLaneSeal(binding, value));
      expect(written.state).toBe("written");
      const recalled = readSLoomCache(root, binding, "use");
      expect(recalled.state).toBe("hit");
      expect(recalled.entry?.value).toMatchObject({ finding: "cache proof" });
      execFileSync(join(root, "bin", "hsc"), ["evict", binding.family, binding.key], { cwd: root });
      expect(readSLoomCache(root, binding, "use").state).toBe("hit");
      expect(readSLoomCache(root, { ...binding, roleId: "wrong-role" }, "use").state).toBe("invalid");
      const reviseBinding = { ...binding, key: `${binding.key}:revise` };
      const refused = writeSLoomCache(root, reviseBinding, role, "judged_lane_seal", value, proofRef, "revise", "refresh", digestSLoomLaneSeal(reviseBinding, value));
      expect(refused.state).toBe("refused");
      const collapseBinding = { ...binding, key: `${binding.key}:collapse` };
      const collapsed = writeSLoomCache(root, collapseBinding, role, "judged_lane_seal", value, proofRef, "collapse", "refresh", digestSLoomLaneSeal(collapseBinding, value));
      expect(collapsed.state).toBe("refused");
      const trap = writeSLoomCache(root, binding, role, "trap" as "judged_lane_seal", "timeout", "fixture:cache-trap", null, "refresh");
      expect(trap.state).toBe("refused");
      const legacyBinding = { ...binding, key: `${binding.key}:legacy-trap` };
      execFileSync(join(root, "bin", "hsc"), ["put", legacyBinding.family, legacyBinding.key, "--class", "trap", "--provenance", "fixture:legacy-trap"], { cwd: root, input: JSON.stringify({ schema: "codex-harness.s-loom-memory.v1", kind: "trap", error: "legacy failure" }) });
      expect(readSLoomCache(root, legacyBinding, "use").state).toBe("invalid");
      await writeFile(proofPath, "{\"verdict\":\"tampered\"}\n");
      expect(readSLoomCache(root, binding, "use")).toMatchObject({ state: "invalid", error: expect.stringMatching(/proof artifact hash/) });
    } finally {
      if (previous.hot === undefined) delete process.env.HSC_HOT_DIR; else process.env.HSC_HOT_DIR = previous.hot;
      if (previous.data === undefined) delete process.env.HSC_DATA_DIR; else process.env.HSC_DATA_DIR = previous.data;
      if (previous.kv === undefined) delete process.env.HSC_KV_DISABLED; else process.env.HSC_KV_DISABLED = previous.kv;
    }
  });

  it("requires exact one-time judge classification of every lane digest", () => {
    const supplied = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
    expect(validateJudgeDigestClassification(supplied, supplied.slice(0, 2), supplied.slice(2))).toBe(true);
    expect(validateJudgeDigestClassification(supplied, supplied.slice(0, 2), [])).toBe(false);
    expect(validateJudgeDigestClassification(supplied, [...supplied, "d".repeat(64)], [])).toBe(false);
    expect(validateJudgeDigestClassification(supplied, [supplied[0]!, supplied[0]!], supplied.slice(1))).toBe(false);
    expect(validateJudgeDigestClassification([supplied[0]!, supplied[0]!], [supplied[0]!], [])).toBe(false);
    expect(validateJudgeDecision(supplied, { verdict: "proceed", acceptedLaneDigests: [supplied[0]!], rejectedLaneDigests: supplied.slice(1) })).toBe(false);
    expect(validateJudgeDecision(supplied, { verdict: "proceed", acceptedLaneDigests: supplied.slice(0, 2), rejectedLaneDigests: supplied.slice(2) })).toBe(true);
  });

  it("requires a full verifier pass before promoting a writer result", () => {
    expect(resolveClusterVerdict({ earned: true, laneSealCount: 3, judgeVerdict: "proceed", writerOk: true, verifierVerdict: "pass" })).toBe("pass");
    expect(resolveClusterVerdict({ earned: true, laneSealCount: 3, judgeVerdict: "proceed", writerOk: true, verifierVerdict: "partial" })).toBe("partial");
    expect(resolveClusterVerdict({ earned: true, laneSealCount: 3, judgeVerdict: "proceed", writerOk: false, verifierVerdict: null })).toBe("partial");
  });

  it("resolves nested Codex working directories through the filesystem boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-harness-workspace-boundary-"));
    const outside = await mkdtemp(join(tmpdir(), "codex-harness-workspace-outside-"));
    tempRoots.push(root, outside);
    await mkdir(join(root, "inside"));
    await symlink("inside", join(root, "inside-link"));
    await symlink(outside, join(root, "escape-link"));
    expect(resolveWorkspaceDirectory(root, "inside-link")).toBe(join(root, "inside"));
    expect(() => resolveWorkspaceDirectory(root, "escape-link")).toThrow(/outside workspace.*symlink/i);
  });

  it("disables workspace cache identity when untracked content cannot be fully hashed", async () => {
    const repo = await mkdtemp(join(tmpdir(), "codex-harness-large-untracked-"));
    tempRoots.push(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    await writeFile(join(repo, "tracked.txt"), "baseline\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=Harness Test", "-c", "user.email=harness@example.invalid", "commit", "-qm", "baseline"], { cwd: repo });
    await writeFile(join(repo, "oversized.bin"), Buffer.alloc(16 * 1024 * 1024 + 1));
    expect(() => workspaceStateSha(repo)).toThrow(/full-hash budget/);
  });

  it("hashes declared behaviorally relevant ignored inputs", async () => {
    const repo = await mkdtemp(join(tmpdir(), "codex-harness-ignored-input-"));
    tempRoots.push(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    await writeFile(join(repo, ".gitignore"), "ignored.cfg\n");
    await writeFile(join(repo, "tracked.txt"), "baseline\n");
    execFileSync("git", ["add", ".gitignore", "tracked.txt"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=Harness Test", "-c", "user.email=harness@example.invalid", "commit", "-qm", "baseline"], { cwd: repo });
    await writeFile(join(repo, "ignored.cfg"), "aa\n");
    await mkdir(join(repo, "nested"));
    const first = workspaceStateSha(join(repo, "nested"), ["ignored.cfg"]);
    await writeFile(join(repo, "ignored.cfg"), "bb\n");
    const second = workspaceStateSha(join(repo, "nested"), ["ignored.cfg"]);
    expect(second).not.toBe(first);
  });

  it("disables smart-cache reuse for untracked symlink inputs", async () => {
    const repo = await mkdtemp(join(tmpdir(), "codex-harness-untracked-symlink-"));
    tempRoots.push(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    await writeFile(join(repo, "tracked.txt"), "baseline\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=Harness Test", "-c", "user.email=harness@example.invalid", "commit", "-qm", "baseline"], { cwd: repo });
    await symlink("tracked.txt", join(repo, "untracked-link"));
    expect(() => workspaceStateSha(repo)).toThrow(/symlink.*disabled/);
  });

  it("hashes the live target of a tracked symlink even when that target is ignored", async () => {
    const repo = await mkdtemp(join(tmpdir(), "codex-harness-tracked-symlink-"));
    tempRoots.push(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    await writeFile(join(repo, ".gitignore"), "runtime.cfg\n");
    await symlink("runtime.cfg", join(repo, "runtime-link"));
    execFileSync("git", ["add", ".gitignore", "runtime-link"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=Harness Test", "-c", "user.email=harness@example.invalid", "commit", "-qm", "baseline"], { cwd: repo });
    await writeFile(join(repo, "runtime.cfg"), "aa\n");
    const first = workspaceStateSha(repo);
    await writeFile(join(repo, "runtime.cfg"), "bb\n");
    expect(workspaceStateSha(repo)).not.toBe(first);
  });

  it("disables smart-cache reuse when a tracked symlink resolves outside the workspace", async () => {
    const repo = await mkdtemp(join(tmpdir(), "codex-harness-external-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "codex-harness-external-target-"));
    tempRoots.push(repo, outside);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    await writeFile(join(outside, "target.txt"), "external\n");
    await symlink(join(outside, "target.txt"), join(repo, "external-link"));
    execFileSync("git", ["add", "external-link"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=Harness Test", "-c", "user.email=harness@example.invalid", "commit", "-qm", "baseline"], { cwd: repo });
    expect(() => workspaceStateSha(repo)).toThrow(/outside the Git workspace/);
  });

  it("disables smart-cache reuse for dirty Git submodule content", async () => {
    const child = await mkdtemp(join(tmpdir(), "codex-harness-submodule-child-"));
    const repo = await mkdtemp(join(tmpdir(), "codex-harness-submodule-parent-"));
    tempRoots.push(child, repo);
    execFileSync("git", ["init", "-q"], { cwd: child });
    await writeFile(join(child, "tracked.txt"), "baseline\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: child });
    execFileSync("git", ["-c", "user.name=Harness Test", "-c", "user.email=harness@example.invalid", "commit", "-qm", "baseline"], { cwd: child });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "dep"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=Harness Test", "-c", "user.email=harness@example.invalid", "commit", "-qam", "baseline"], { cwd: repo });
    await writeFile(join(repo, "dep", "tracked.txt"), "dirty\n");
    expect(() => workspaceStateSha(repo)).toThrow(/dirty Git submodule/);
  });

  it("refuses unused or unqualified stacked-lobe persona swap keys", async () => {
    const tools = new Map<string, Record<string, unknown>>();
    codexPiHarnessExtension({ registerCommand: () => undefined, registerTool: (definition) => tools.set(String(definition.name), definition) });
    const planner = tools.get("codex_s_lobe_plan") as { execute: (...args: unknown[]) => Promise<unknown> };
    await expect(planner.execute("fixture", { objective: "plan", profiles: ["review", "architecture", "harness"], personaSwaps: { typo: "metric-skeptic" } }, undefined, undefined, { cwd: workspace })).rejects.toThrow(/profile-qualified|unused/);
    await expect(planner.execute("fixture", { objective: "plan", profiles: ["review", "architecture", "harness"], personaSwaps: { "review.failure-adversary": "not-in-manifest" } }, undefined, undefined, { cwd: workspace })).rejects.toThrow(/not registered/);
    const planned = await planner.execute("fixture", { objective: "plan", profiles: ["review", "architecture", "harness"], personaSwaps: { "review.failure-adversary": "metric-skeptic" } }, undefined, undefined, { cwd: workspace }) as { details: { micro: Array<{ roleId: string; persona: { id: string; swapState: string } }> } };
    expect(planned.details.micro.find((seat) => seat.roleId === "failure-adversary")?.persona).toMatchObject({ id: "metric-skeptic", swapState: "hot_swapped" });
  });

  it("executes the Habitat roster baseline measurement", async () => {
    const tools = new Map<string, Record<string, unknown>>();
    codexPiHarnessExtension({ registerCommand: () => undefined, registerTool: (definition) => tools.set(String(definition.name), definition) });
    const inventory = tools.get("habitat_loom_inventory") as { execute: (...args: unknown[]) => Promise<{ details: { habitatOperationalRoster: { separationProof: { state: string; currentSha256: string; expectedSha256: string } } } }> };
    const result = await inventory.execute("fixture", {}, undefined, undefined, { cwd: workspace });
    expect(result.details.habitatOperationalRoster.separationProof.state).toBe("verified_baseline_match");
    expect(result.details.habitatOperationalRoster.separationProof.currentSha256).toBe(result.details.habitatOperationalRoster.separationProof.expectedSha256);
  });

  it("pins SOL 5.6 workspace-write runtime behind explicit confirmations", () => {
    expect(() => buildCodexRuntimeProfile(workspace, {})).toThrow(/confirmWorkspaceWrite=true/);
    const profile = buildCodexRuntimeProfile(workspace, { accessMode: "workspace_write", confirmWorkspaceWrite: true });
    expect(profile.threadOptions.model).toBe("gpt-5.6-sol");
    expect(profile.threadOptions.sandboxMode).toBe("workspace-write");
    expect(profile.threadOptions.approvalPolicy).toBe("never");
    expect(profile.threadOptions.networkAccessEnabled).toBe(false);
    expect(profile.modelReasoningEffort).toBe("max");
    expect(profile.clientConfig.model_reasoning_effort).toBe("max");
    expect(() => buildCodexRuntimeProfile(workspace, { accessMode: "read_only", networkAccessEnabled: true })).toThrow(/confirmNetworkAccess=true/);
  });

  it("validates the SOL task-result Zod contract", () => {
    const parsed = HARNESS_ZOD_SCHEMAS.sol56_task_result.safeParse({ status: "ok", summary: "done", changedFiles: ["src/a.ts"], commands: ["npm test"], verification: ["tests pass"] });
    expect(parsed.success).toBe(true);
  });

  it("blocks armed terminal commands without disabling productive shell work", async () => {
    let toolCallHook: ((event: { toolName?: string; input?: Record<string, unknown> }, ctx: { cwd: string }) => Promise<{ block: true; reason: string } | undefined>) | undefined;
    codexPiHarnessExtension({
      on: (_event, handler) => { toolCallHook = handler; },
      registerCommand: () => undefined,
      registerTool: () => undefined,
    });
    expect(toolCallHook).toBeDefined();
    await expect(toolCallHook?.({ toolName: "bash", input: { command: "npm install && git push" } }, { cwd: workspace })).resolves.toMatchObject({ block: true });
    await expect(toolCallHook?.({ toolName: "bash", input: { command: "npm install --ignore-scripts" } }, { cwd: workspace })).resolves.toBeUndefined();
    await expect(toolCallHook?.({ toolName: "write", input: { path: "../outside.txt" } }, { cwd: workspace })).resolves.toMatchObject({ block: true });
    await expect(toolCallHook?.({ toolName: "edit", input: {} }, { cwd: workspace })).resolves.toMatchObject({ block: true });
    await expect(toolCallHook?.({ toolName: "write", input: { path: "deploy/release.txt" } }, { cwd: workspace })).resolves.toMatchObject({ block: true });
    await expect(toolCallHook?.({ toolName: "write", input: { path: ".git/config" } }, { cwd: workspace })).resolves.toMatchObject({ block: true });
  });

  it("blocks native write tools from escaping through workspace symlinks", async () => {
    const cwd = await tempWorkspace();
    const outside = await mkdtemp(join(tmpdir(), "codex-harness-outside-"));
    tempRoots.push(outside);
    await symlink(outside, join(cwd, "escape-link"), "dir");
    let toolCallHook: ((event: { toolName?: string; input?: Record<string, unknown> }, ctx: { cwd: string }) => Promise<{ block: true; reason: string } | undefined>) | undefined;
    codexPiHarnessExtension({
      on: (_event, handler) => { toolCallHook = handler; },
      registerCommand: () => undefined,
      registerTool: () => undefined,
    });
    await expect(toolCallHook?.({ toolName: "write", input: { path: "escape-link/leak.txt" } }, { cwd })).resolves.toMatchObject({ block: true, reason: expect.stringContaining("symlink escape") });
  });

  it("accepts canonical package identity and refuses alternate roots", async () => {
    const cwd = await tempWorkspace();
    let identity = await checkPackageIdentity(cwd);
    expect(identity.ok).toBe(true);

    identity = await checkPackageIdentity(join(cwd, "pi-codex-habitat-harness"));
    expect(identity.ok).toBe(true);

    await mkdir(join(cwd, ".pi-codex-habitat-harness"));
    identity = await checkPackageIdentity(cwd);
    expect(identity.ok).toBe(false);
    expect(identity.refusalReason).toContain("forbidden alternate root");
  });

  it("keeps catastrophic hard stops while allowing productive package work", () => {
    expect(classifyPermission({ cwd: workspace, objective: "review patch status", declaredPermissions: ["read"] }).class).toBe("AUTO");
    expect(classifyPermission({ cwd: workspace, objective: "deploy release", command: "git push && deploy release", declaredPermissions: ["write"] }).class).toBe("GATE");
    expect(classifyPermission({ cwd: workspace, objective: "mixed command", command: "npm install && git push", declaredPermissions: ["write"] }).class).toBe("GATE");
    expect(classifyPermission({ cwd: workspace, objective: "start daemon", command: "deep-diff-forge daemon start" }).class).toBe("BLOCK");
    expect(classifyPermission({ cwd: workspace, objective: "unsafe browser", command: "playwright-cli open https://example.com --no-sandbox" }).class).toBe("BLOCK");
    expect(classifyPermission({ cwd: workspace, objective: "unsafe browser files", command: "PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS=true playwright-cli open" }).class).toBe("BLOCK");
    expect(classifyPermission({ cwd: workspace, objective: "destroy root", command: "rm -rf /" }).class).toBe("BLOCK");
    expect(classifyPermission({ cwd: workspace, objective: "touch git internals", path: ".git/config" }).class).toBe("BLOCK");
    expect(classifyPermission({ cwd: workspace, objective: "install deps; no deploy, push, ship, daemon start, or fabric serve", command: "npm install --ignore-scripts --no-audit --no-fund", declaredPermissions: ["workspace-write", "network", "package-scope"], observedEffects: ["node_modules", "package-lock.json"] }).class).toBe("DEFER");
    expect(classifyPermission({ cwd: workspace, objective: "write outside", path: "../outside.txt" }).class).toBe("DEFER");
  });

  it("writes redacted hash-chained receipts and verifies read-back", async () => {
    const cwd = await tempWorkspace();
    const envelope = createBaseEnvelope({
      cwd,
      objective: "redact OPENAI_API_KEY=fixture-openai-api-key-value",
      verdict: "pass",
    });
    envelope.artifacts.push({ path: "provider", sha256: "0".repeat(64) });
    const written = await appendReceipt(cwd, envelope);
    expect(written.verified).toBe(true);
    expect(written.eventHash).toMatch(/^[a-f0-9]{64}$/);

    const ledger = await verifyReceiptLedger(cwd);
    expect(ledger.ok).toBe(true);
    expect(ledger.count).toBe(1);
    expect(await readLastReceiptCirculationClass(cwd)).toBe("local_file");

    const text = await readFile(written.path, "utf8");
    expect(text).not.toContain("fixture-openai-api-key-value");
    expect(redactSecrets({ api_key: "fixture-openai-api-key-value" })).toEqual({ api_key: "[REDACTED]" });
  });

  it("validates the base RunEnvelope contract", () => {
    const envelope = createBaseEnvelope({ cwd: workspace, objective: "contract fixture" });
    expect(() => RunEnvelopeSchema.parse(envelope)).not.toThrow();
    expect(envelope.packageIdentity.packageName).toBe("pi-codex-habitat-harness");
  });

  it("supports confirmed package-scoped writes and blocks unsafe write targets", async () => {
    const cwd = await tempWorkspace();
    const capacity = observeWriteCapacity(cwd);
    expect(capacity.enabled).toBe(true);
    expect(capacity.hardStopsPreserved).toBe(true);

    const result = await scopedWrite({ cwd, relativePath: ".pi/codex-harness/write-proofs/probe.json", content: "{\"ok\":true}\n", confirmWrite: true });
    expect(result.verified).toBe(true);
    expect(result.safety.class).toBe("DEFER");
    expect(result.receipt.verified).toBe(true);
    await expect(scopedWrite({ cwd, relativePath: "../escape.txt", content: "no", confirmWrite: true })).rejects.toThrow(/outside package root|absolute write path|outside-workspace/);
    await expect(scopedWrite({ cwd, relativePath: "package-lock.json", content: "no", confirmWrite: true })).rejects.toThrow(/blocked package/);
  });

  it("tracks latest receipt circulation instead of historical strongest class", async () => {
    const cwd = await tempWorkspace();

    const localEnvelope = createBaseEnvelope({ cwd, objective: "latest local receipt" });
    await appendReceipt(cwd, localEnvelope);

    const observedEnvelope = createBaseEnvelope({ cwd, objective: "historical observed receipt" });
    observedEnvelope.receiptCirculationClass = "habitat_observed";
    await appendReceipt(cwd, observedEnvelope);

    const finalEnvelope = createBaseEnvelope({ cwd, objective: "back to local receipt" });
    const finalReceipt = await appendReceipt(cwd, finalEnvelope);
    expect(finalReceipt.verified).toBe(true);

    expect(await readLastReceiptCirculationClass(cwd)).toBe("local_file");
    expect(await strongestReceiptCirculationClass(cwd)).toBe("habitat_observed");

    const observation = await observeHabitat(cwd);
    expect(observation.receipt.latestClass).toBe("local_file");
    expect(observation.receipt.externalAckPresent).toBe(false);
  });

  it("builds Habitat-observed read-only surface observations", async () => {
    const observation = await observeHabitat(workspace);
    expect(observation.liveServices.length).toBeGreaterThanOrEqual(18);
    expect(observation.looms.templates).toEqual(["gate", "probe", "ship"]);
    expect(observation.looms.shipArmed).toBe(false);
    expect(observation.zellij.blockedRoutes).toContain("action focus-next-pane");
    expect(observation.justfile.recipeClass).toBe("not_used");
    expect(observation.fabric.dryRun).toBe(true);
    expect(Object.keys(observation.gates)).toEqual(expect.arrayContaining(["GATE-08", "GATE-15", "GATE-20"]));
    expect(observation.gates["GATE-14"]).toBe("pass");
    expect(observation.gates["GATE-18"]).toBe("pass");
    expect(observation.gates["GATE-19"]).toBe("pass");
    expect(observation.gates["GATE-20"]).toBe("pass");
  });

  it("reports actor bridge readiness without live auth over-claim", () => {
    const status = actorBridgeStatus(workspace);
    expect(status.codexSdk.liveCallState).not.toBe("passed");
    expect(status.agentsTs.liveCallState).not.toBe("passed");
    expect(["offline_fixture_ready", "live_ready", "auth_missing"]).toContain(status.codexSdk.state);
  });

  it("runs DDF review/rank/cluster fixtures without mutating patch truth", async () => {
    const status = ddfStatus(workspace);
    if (!status.binary || status.engineState === "unavailable") {
      console.warn("deep-diff-forge unavailable; skipping live fixture assertions");
      return;
    }
    const patch = await readFile("fixtures/deep-diff-forge/simple.patch", "utf8");
    const review = reviewPatch(workspace, patch, "review");
    const rank = reviewPatch(workspace, patch, "rank");
    const cluster = reviewPatch(workspace, patch, "cluster");
    expect(review.exitCode).toBe(0);
    expect(rank.exitCode).toBe(0);
    expect(cluster.exitCode).toBe(0);
    expect(review.schema).toBe("deep-diff-forge.review.v0");
    expect(rank.schema).toBe("deep-diff-forge.rank.v0");
    expect(cluster.schema).toBe("deep-diff-forge.cluster.v0");
    expect(review.patchTruthPreserved).toBe(true);
    expect(existsSync(status.binary)).toBe(true);
  });

  it("captures malformed DDF patch as typed review failure", async () => {
    const status = ddfStatus(workspace);
    if (!status.binary || status.engineState === "unavailable") return;
    const patch = await readFile("fixtures/deep-diff-forge/malformed.patch", "utf8");
    const result = reviewPatch(workspace, patch, "review");
    expect(result.exitCode).toBe(4);
    expect(result.typedFailure).toBe("parse_failure");
    expect(result.patchTruthPreserved).toBe(true);
  });
});
