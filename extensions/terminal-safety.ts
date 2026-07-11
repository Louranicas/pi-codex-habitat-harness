import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { classifyPermission } from "./codex-safety-membrane.js";
import { workspaceRootFor } from "./package-identity.js";

type ToolCallEvent = { toolName?: string; input?: Record<string, unknown> };
type ToolCallContext = { cwd: string };
type PiApi = { on?: (event: "tool_call", handler: (event: ToolCallEvent, ctx: ToolCallContext) => Promise<{ block: true; reason: string } | undefined>) => void };

function inputPath(input: Record<string, unknown>): string | null {
  for (const key of ["path", "filePath", "file_path"]) {
    if (typeof input[key] === "string") return input[key];
  }
  return null;
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

function canonicalWriteTarget(candidate: string): string {
  const suffix: string[] = [];
  let cursor = candidate;
  while (true) {
    try {
      lstatSync(cursor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      suffix.unshift(cursor.slice(parent.length + 1));
      cursor = parent;
    }
  }
  return resolve(realpathSync(cursor), ...suffix);
}

export function registerTerminalSafety(pi: PiApi): void {
  pi.on?.("tool_call", async (event, ctx) => {
    const toolName = event.toolName ?? "";
    const input = event.input ?? {};
    const workspace = workspaceRootFor(ctx.cwd);

    if (toolName === "bash") {
      const command = typeof input.command === "string" ? input.command : "";
      const classification = classifyPermission({ cwd: workspace, objective: "Pi terminal command", command, declaredPermissions: ["workspace_write"] });
      if (classification.class === "BLOCK" || classification.class === "GATE") {
        return { block: true, reason: `Codex Harness terminal membrane: ${classification.class} - ${classification.reason}` };
      }
      return undefined;
    }

    if (toolName === "write" || toolName === "edit") {
      const candidate = inputPath(input);
      if (!candidate) return { block: true, reason: `Codex Harness terminal membrane: ${toolName} path missing` };
      const resolved = isAbsolute(candidate) ? resolve(candidate) : resolve(ctx.cwd, candidate);
      if (!isInside(workspace, resolved)) return { block: true, reason: `Codex Harness terminal membrane: outside-workspace write refused: ${candidate}` };
      let canonicalTarget: string;
      try {
        canonicalTarget = canonicalWriteTarget(resolved);
      } catch {
        return { block: true, reason: `Codex Harness terminal membrane: unresolved or broken-symlink write refused: ${candidate}` };
      }
      const canonicalWorkspace = realpathSync(workspace);
      if (!isInside(canonicalWorkspace, canonicalTarget)) return { block: true, reason: `Codex Harness terminal membrane: symlink escape refused: ${candidate}` };
      const classification = classifyPermission({ cwd: workspace, objective: `Pi ${toolName}`, path: resolved, declaredPermissions: ["workspace_write"] });
      if (classification.class === "BLOCK" || classification.class === "GATE") return { block: true, reason: `Codex Harness terminal membrane: ${classification.class} - ${classification.reason}` };
    }
    return undefined;
  });
}
