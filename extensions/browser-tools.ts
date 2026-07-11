import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { appendReceipt, receiptLedgerPath, redactSecrets } from "./codex-receipts.js";
import { workspaceRootFor } from "./package-identity.js";
import { createBaseEnvelope } from "./run-envelope.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; details?: unknown };
type PiApi = { registerTool: (definition: Record<string, unknown>) => void };

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const MAX_EVIDENCE_FILES = 32;
const MAX_EVIDENCE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_EVIDENCE_TOTAL_BYTES = 128 * 1024 * 1024;

function packageVersion(name: string): string | null {
  try {
    const path = join(packageRoot, "node_modules", ...name.split("/"), "package.json");
    const value = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
    return typeof value.version === "string" ? value.version : null;
  } catch {
    return null;
  }
}

function commandVersion(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return execFileSync(path, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
  } catch {
    return null;
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function sha256File(handle: FileHandle): Promise<string> {
  return await new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = handle.createReadStream({ autoClose: false, start: 0 });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

export interface BrowserEvidenceArtifact {
  path: string;
  sha256: string;
  bytes: number;
}

export async function collectBrowserEvidence(cwd: string, artifactPaths: string[]): Promise<BrowserEvidenceArtifact[]> {
  if (artifactPaths.length === 0) throw new Error("at least one browser evidence artifact is required");
  if (artifactPaths.length > MAX_EVIDENCE_FILES) throw new Error(`browser evidence is limited to ${MAX_EVIDENCE_FILES} files`);
  const workspace = realpathSync(workspaceRootFor(cwd));
  const seen = new Set<string>();
  const artifacts: BrowserEvidenceArtifact[] = [];
  let totalBytes = 0;

  for (const input of artifactPaths) {
    const lexicalPath = isAbsolute(input) ? resolve(input) : resolve(workspace, input);
    if (!isInside(workspace, lexicalPath)) throw new Error(`browser evidence outside workspace refused: ${input}`);
    if (lstatSync(lexicalPath).isSymbolicLink()) throw new Error(`browser evidence symlink refused: ${input}`);
    const handle = await open(lexicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error(`browser evidence must be a regular file: ${input}`);
      const canonicalPath = realpathSync(`/proc/self/fd/${handle.fd}`);
      if (canonicalPath.endsWith(" (deleted)")) throw new Error(`browser evidence changed during admission: ${input}`);
      if (!isInside(workspace, canonicalPath)) throw new Error(`browser evidence symlink escape refused: ${input}`);
      if (seen.has(canonicalPath)) throw new Error(`duplicate browser evidence artifact refused: ${input}`);
      if (stat.size > MAX_EVIDENCE_FILE_BYTES) throw new Error(`browser evidence file exceeds ${MAX_EVIDENCE_FILE_BYTES} bytes: ${input}`);
      totalBytes += stat.size;
      if (totalBytes > MAX_EVIDENCE_TOTAL_BYTES) throw new Error(`browser evidence exceeds ${MAX_EVIDENCE_TOTAL_BYTES} total bytes`);
      const sha256 = await sha256File(handle);
      const afterHash = await handle.stat();
      if (afterHash.size !== stat.size || afterHash.mtimeMs !== stat.mtimeMs || afterHash.ctimeMs !== stat.ctimeMs) {
        throw new Error(`browser evidence changed while hashing: ${input}`);
      }
      seen.add(canonicalPath);
      artifacts.push({ path: canonicalPath, sha256, bytes: stat.size });
    } finally {
      await handle.close();
    }
  }
  return artifacts;
}

export function browserInventory(cwd: string) {
  const workspace = workspaceRootFor(cwd);
  const configPath = join(workspace, ".playwright", "cli.config.json");
  let config: unknown = null;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    config = null;
  }
  return {
    executionPlane: "terminal_first_playwright_cli",
    mcpRequired: false,
    versions: {
      playwrightCli: packageVersion("@playwright/cli"),
      playwrightCore: packageVersion("playwright-core"),
    },
    command: join(packageRoot, "node_modules", ".bin", "playwright-cli"),
    browsers: {
      chrome: { path: "/usr/bin/google-chrome", version: commandVersion("/usr/bin/google-chrome") },
      chromeStable: { path: "/usr/bin/google-chrome-stable", version: commandVersion("/usr/bin/google-chrome-stable") },
      firefox: { path: "/usr/bin/firefox", version: commandVersion("/usr/bin/firefox") },
    },
    config: { path: configPath, loaded: config !== null, value: config },
    outputDirectory: join(workspace, ".pi", "codex-harness", "browser"),
    defaultSession: process.env.PLAYWRIGHT_CLI_SESSION ?? null,
    capabilities: [
      "accessibility_snapshot_refs",
      "desktop_mobile_emulation",
      "screenshots_pdf",
      "console_network_evidence",
      "request_mocking",
      "tracing_video",
      "isolated_named_sessions",
      "confirmed_existing_browser_attachment",
    ],
    safety: {
      defaultProfile: "isolated_ephemeral",
      defaultHeadless: true,
      downloadsAccepted: false,
      serviceWorkers: "block",
      unrestrictedFileAccess: false,
      authenticatedProfileAttachmentRequiresUserConfirmation: true,
      remoteStateMutationRequiresUserConfirmation: true,
    },
  };
}

export function registerBrowserTools(pi: PiApi): void {
  pi.registerTool({
    name: "codex_browser_inventory",
    label: "Codex Browser Inventory",
    description: "Inventory the terminal-first Playwright CLI, installed browsers, isolated defaults, evidence directory, and browser capabilities. Read-only; no browser is launched.",
    promptSnippet: "Inspect Codex Harness browser automation capacity before browser work",
    promptGuidelines: [
      "Use codex_browser_inventory before claiming browser automation is available.",
      "Prefer playwright-cli in the terminal; the harness intentionally does not require a browser MCP.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }): Promise<ToolResult> {
      const details = redactSecrets(browserInventory(ctx.cwd));
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
    },
  });

  pi.registerTool({
    name: "codex_browser_evidence_seal",
    label: "Codex Browser Evidence Seal",
    description: "Hash and seal workspace-contained Playwright screenshots, snapshots, traces, console or network evidence into the Codex Harness receipt chain. Does not launch or control a browser.",
    promptSnippet: "Seal browser evidence files into a verified local harness receipt",
    promptGuidelines: [
      "Use after browser verification to bind the exact evidence files to a hash-chained receipt.",
      "Set remoteStateChanged accurately; authenticated or remote state-changing browser actions require explicit user confirmation before execution.",
    ],
    parameters: Type.Object({
      objective: Type.String({ description: "Browser workflow or assertion that this evidence supports" }),
      artifactPaths: Type.Array(Type.String(), { minItems: 1, maxItems: MAX_EVIDENCE_FILES, description: "Workspace-relative or absolute evidence files" }),
      verdict: Type.Optional(Type.String({ enum: ["pass", "fail", "partial", "unknown"], description: "Evidence verdict, default unknown" })),
      networkUsed: Type.Optional(Type.Boolean({ description: "Whether the browser accessed a network origin" })),
      remoteStateChanged: Type.Optional(Type.Boolean({ description: "Whether the browser changed remote application state" })),
      confirmRemoteStateChange: Type.Optional(Type.Boolean({ description: "Must be true if remoteStateChanged is true" })),
    }),
    async execute(_toolCallId: string, params: { objective: string; artifactPaths: string[]; verdict?: "pass" | "fail" | "partial" | "unknown"; networkUsed?: boolean; remoteStateChanged?: boolean; confirmRemoteStateChange?: boolean }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }): Promise<ToolResult> {
      if (params.remoteStateChanged === true && params.confirmRemoteStateChange !== true) {
        throw new Error("remoteStateChanged=true requires confirmRemoteStateChange=true");
      }
      const workspace = workspaceRootFor(ctx.cwd);
      const artifacts = await collectBrowserEvidence(workspace, params.artifactPaths);
      const permissions = ["read", "local_file_write", "browser_evidence"];
      if (params.networkUsed === true) permissions.push("network");
      if (params.remoteStateChanged === true) permissions.push("remote_state_write");
      const envelope = createBaseEnvelope({
        cwd: workspace,
        objective: params.objective,
        kind: "review",
        verdict: params.verdict ?? "unknown",
        safety: {
          class: params.remoteStateChanged === true ? "DEFER" : "AUTO",
          reason: params.remoteStateChanged === true
            ? "user-confirmed remote browser state change plus local evidence sealing"
            : "read-only browser evidence plus local receipt write",
          declaredPermissions: permissions,
          observedEffects: [receiptLedgerPath(workspace)],
          permissionDelta: "expected",
        },
      });
      envelope.skillUsed = "auto";
      envelope.artifacts.push(...artifacts.map(({ path, sha256 }) => ({ path, sha256 })));
      const receipt = await appendReceipt(workspace, envelope);
      const details = redactSecrets({
        artifacts,
        receipt: { path: receipt.path, eventHash: receipt.eventHash, verified: receipt.verified },
        verdict: envelope.verdict,
        networkUsed: params.networkUsed === true,
        remoteStateChanged: params.remoteStateChanged === true,
      });
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
    },
  });
}
