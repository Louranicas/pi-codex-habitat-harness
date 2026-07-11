import { isAbsolute, normalize, relative, resolve } from "node:path";

export type SafetyClass = "AUTO" | "DEFER" | "GATE" | "BLOCK";

export interface PermissionClassificationInput {
  objective: string;
  cwd: string;
  command?: string;
  path?: string;
  declaredPermissions?: string[];
  observedEffects?: string[];
}

export interface PermissionClassification {
  class: SafetyClass;
  reason: string;
  declaredPermissions: string[];
  observedEffects: string[];
  permissionDelta: "none" | "expected" | "violation" | "unknown";
}

const HARD_STOP_PATTERNS = [
  /danger-full-access/i,
  /factory\.authorize\./i,
  /deep-diff-forge\s+daemon\s+start/i,
  /fabric\s+--serve/i,
  /\bdaemon\s+start\b/i,
  /\bplaywright-cli\b[^\n]*(?:--no-sandbox|--allow-unrestricted-file-access)\b/i,
  /\bPLAYWRIGHT_MCP_(?:NO_SANDBOX|ALLOW_UNRESTRICTED_FILE_ACCESS)\s*=\s*(?:1|true)\b/i,
];

const CATASTROPHIC_PATTERNS = [
  /rm\s+-(?:[^\s]*r[^\s]*f|[^\s]*f[^\s]*r)\s+\/?(?:\s|$)/i,
  /rm\s+-(?:[^\s]*r[^\s]*f|[^\s]*f[^\s]*r)\s+(?:~|\$HOME)(?:\s|\/|$)/i,
  /rm\s+-(?:[^\s]*r[^\s]*f|[^\s]*f[^\s]*r)\s+[^;&|]*(?:\.git|claude-code-workspace|projects\/shared-context)(?:\s|\/|$)/i,
  /\b(?:mkfs|wipefs|shred)\b/i,
  /\bdd\b[^;&|]*\bof=\/(?:dev|etc|bin|usr|var|home)\b/i,
  /chmod\s+-R\s+777\s+\/(?:\s|$)/i,
  /chown\s+-R\s+[^\s]+\s+\/(?:\s|$)/i,
];

const ARMED_PATTERNS = [
  /cargo\s+publish/i,
  /git\s+push/i,
  /git\s+tag/i,
  /\bship\b/i,
  /\bdeploy\b/i,
  /\brestart\b/i,
  /\bwrite-chars\b/i,
  /\bzellij\s+pipe\b/i,
  /npm\s+audit\s+fix/i,
];

const READ_ONLY_PATTERNS = [
  /\bstatus\b/i,
  /\bread\b/i,
  /\bprobe\b/i,
  /\bclassify\b/i,
  /\breview\b/i,
  /\brank\b/i,
  /\bcluster\b/i,
  /--self-test/i,
  /deploy\s+status/i,
];

const PRODUCTIVE_PACKAGE_PATTERNS = [
  /\bnpm\s+(?:install|ci|update)\b/i,
  /\bnpm\s+run\s+(?:selftest|typecheck|test|status|arena)\b/i,
  /\bnpx\b/i,
  /\b(?:pnpm|yarn)\s+(?:install|test|run)\b/i,
];

const NEGATED_HARD_STOP_PHRASES = [
  /\b(?:no|without)\s+(?:deploy|push|ship|restart|daemon\s+start|fabric\s+serve|factory\s+authorize)(?:(?:\s*,\s*(?:(?:or|and)\s+)?|\s+(?:or|and)\s+)(?:deploy|push|ship|restart|daemon\s+start|fabric\s+serve|factory\s+authorize))+/gi,
  /\bno\s+(?:deploy|push|ship|restart|daemon\s+start|fabric\s+serve|factory\s+authorize)\b/gi,
  /\bwithout\s+(?:deploy|push|ship|restart|daemon\s+start|fabric\s+serve|factory\s+authorize)\b/gi,
  /\bdo\s+not\s+(?:deploy|push|ship|restart|start\s+daemon|serve\s+fabric)\b/gi,
];

function sanitizeIntent(text: string): string {
  return NEGATED_HARD_STOP_PHRASES.reduce((acc, pattern) => acc.replace(pattern, "[hard-stop-negated]"), text);
}

function hasWriteLikePermission(declaredPermissions: string[]): boolean {
  return declaredPermissions.some((permission) => /write|mutat|network|package-scope|workspace/i.test(permission));
}

export function classifyPermission(input: PermissionClassificationInput): PermissionClassification {
  const declaredPermissions = input.declaredPermissions ?? [];
  const observedEffects = input.observedEffects ?? [];
  const commandSubject = [input.command ?? "", input.path ?? ""].join("\n");
  const intentSubject = sanitizeIntent([input.objective, input.command ?? "", input.path ?? "", ...declaredPermissions].join("\n"));

  const pathClassification = input.path ? classifyPath(input.cwd, input.path) : null;
  if (pathClassification?.class === "BLOCK") {
    return {
      class: "BLOCK",
      reason: pathClassification.reason,
      declaredPermissions,
      observedEffects,
      permissionDelta: observedEffects.length > 0 ? "violation" : "none",
    };
  }

  if (HARD_STOP_PATTERNS.some((pattern) => pattern.test(commandSubject))) {
    return { class: "BLOCK", reason: "matches hard-stop command forbidden by S1008820", declaredPermissions, observedEffects, permissionDelta: observedEffects.length > 0 ? "violation" : "none" };
  }
  if (CATASTROPHIC_PATTERNS.some((pattern) => pattern.test(commandSubject))) {
    return { class: "BLOCK", reason: "matches catastrophic deletion/system-damage pattern", declaredPermissions, observedEffects, permissionDelta: observedEffects.length > 0 ? "violation" : "none" };
  }

  if (ARMED_PATTERNS.some((pattern) => pattern.test(intentSubject))) {
    return { class: "GATE", reason: "requires explicit arming/gate; not a catastrophic block", declaredPermissions, observedEffects, permissionDelta: observedEffects.length > 0 ? "unknown" : "none" };
  }

  if (PRODUCTIVE_PACKAGE_PATTERNS.some((pattern) => pattern.test(commandSubject))) {
    return {
      class: hasWriteLikePermission(declaredPermissions) || observedEffects.length > 0 ? "DEFER" : "AUTO",
      reason: "productive package/tooling action allowed; catastrophic deletion and hard-stop routes remain blocked",
      declaredPermissions,
      observedEffects,
      permissionDelta: observedEffects.length > 0 ? "expected" : "none",
    };
  }

  if (pathClassification?.class === "DEFER") {
    return { class: "DEFER", reason: pathClassification.reason, declaredPermissions, observedEffects, permissionDelta: observedEffects.length > 0 ? "unknown" : "none" };
  }
  if (hasWriteLikePermission(declaredPermissions)) {
    return { class: "DEFER", reason: "write/network/package action allowed after normal confirmation; catastrophic paths remain blocked", declaredPermissions, observedEffects, permissionDelta: observedEffects.length > 0 ? "expected" : "none" };
  }
  if (READ_ONLY_PATTERNS.some((pattern) => pattern.test(intentSubject))) {
    return { class: "AUTO", reason: "read-only/offline diagnostic or review action", declaredPermissions, observedEffects, permissionDelta: observedEffects.length > 0 ? "violation" : "none" };
  }
  return { class: "AUTO", reason: "unclassified non-mutating intent allowed by productivity membrane", declaredPermissions, observedEffects, permissionDelta: observedEffects.length > 0 ? "unknown" : "none" };
}

function classifyPath(cwd: string, candidate: string): { class: SafetyClass; reason: string } {
  const resolved = isAbsolute(candidate) ? normalize(candidate) : resolve(cwd, candidate);
  const rel = relative(cwd, resolved);
  const normalized = resolved.replace(/\\/g, "/");
  const criticalExact = new Set(["/", "/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/proc", "/root", "/sbin", "/sys", "/usr", "/var"]);
  const criticalPrefixes = ["/bin/", "/boot/", "/dev/", "/etc/", "/lib/", "/lib64/", "/proc/", "/root/", "/sbin/", "/sys/", "/usr/", "/var/"];

  if (criticalExact.has(normalized) || criticalPrefixes.some((prefix) => normalized.startsWith(prefix))) {
    return { class: "BLOCK", reason: `critical operating-system path refused: ${candidate}` };
  }
  if (normalized.endsWith("/.git") || normalized.includes("/.git/")) {
    return { class: "BLOCK", reason: ".git mutation is blocked" };
  }
  if (rel === ".morph" || rel.startsWith(`.morph/`)) {
    return { class: "BLOCK", reason: "root .morph clobber is blocked" };
  }
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { class: "DEFER", reason: `outside-current-root path allowed with normal caution: ${candidate}` };
  }
  return { class: "AUTO", reason: "path is inside current root" };
}

export function reconcileObservedEffects(declared: string[], observed: string[]): PermissionClassification["permissionDelta"] {
  if (observed.length === 0) return "none";
  const undeclared = observed.filter((effect) => !declared.includes(effect));
  return undeclared.length === 0 ? "expected" : "violation";
}
