import { existsSync, readFileSync, realpathSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { FORBIDDEN_ALTERNATE_ROOT, PACKAGE_IDENTITY } from "./constants.js";

export interface PackageIdentityCheck {
  ok: boolean;
  packageName: typeof PACKAGE_IDENTITY.packageName;
  packageRoot: typeof PACKAGE_IDENTITY.packageRoot;
  receiptNamespace: typeof PACKAGE_IDENTITY.receiptNamespace;
  canonicalRoot: string;
  alternateRoot: string;
  canonicalRootPresent: boolean;
  forbiddenAlternateRootPresent: boolean;
  refusalReason?: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function readPackageName(path: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name : null;
  } catch {
    return null;
  }
}

export function workspaceRootFor(cwd: string): string {
  if (existsSync(join(cwd, "package.json")) && readPackageName(join(cwd, "package.json")) === PACKAGE_IDENTITY.packageName) {
    return dirname(cwd);
  }
  return cwd;
}

export function resolveWorkspaceDirectory(ctxCwd: string, requested?: string): string {
  const workspace = realpathSync(workspaceRootFor(ctxCwd));
  const lexicalCandidate = requested
    ? (isAbsolute(requested) ? resolve(requested) : resolve(workspace, requested))
    : workspace;
  let candidate: string;
  try {
    candidate = realpathSync(lexicalCandidate);
  } catch (error) {
    throw new Error(`workingDirectory cannot be resolved: ${requested ?? lexicalCandidate}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const rel = relative(workspace, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`workingDirectory outside workspace refused after symlink resolution: ${requested ?? candidate}`);
  return candidate;
}

export async function checkPackageIdentity(workspaceCwd: string): Promise<PackageIdentityCheck> {
  const normalizedWorkspace = workspaceRootFor(workspaceCwd);
  const canonicalRoot = join(normalizedWorkspace, PACKAGE_IDENTITY.packageRoot);
  const alternateRoot = join(normalizedWorkspace, FORBIDDEN_ALTERNATE_ROOT);
  const canonicalRootPresent = await exists(canonicalRoot);
  const forbiddenAlternateRootPresent = await exists(alternateRoot);

  const refusalReasons: string[] = [];
  if (!canonicalRootPresent) refusalReasons.push(`canonical root missing: ${PACKAGE_IDENTITY.packageRoot}`);
  if (forbiddenAlternateRootPresent) refusalReasons.push(`forbidden alternate root present: ${FORBIDDEN_ALTERNATE_ROOT}`);

  const result: PackageIdentityCheck = {
    ok: refusalReasons.length === 0,
    ...PACKAGE_IDENTITY,
    canonicalRoot,
    alternateRoot,
    canonicalRootPresent,
    forbiddenAlternateRootPresent,
  };
  if (refusalReasons.length > 0) result.refusalReason = refusalReasons.join("; ");
  return result;
}
