import { access } from "node:fs/promises";
import { join } from "node:path";
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

export async function checkPackageIdentity(workspaceCwd: string): Promise<PackageIdentityCheck> {
  const canonicalRoot = join(workspaceCwd, PACKAGE_IDENTITY.packageRoot);
  const alternateRoot = join(workspaceCwd, FORBIDDEN_ALTERNATE_ROOT);
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
