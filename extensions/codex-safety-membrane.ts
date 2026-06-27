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

const BLOCK_PATTERNS = [
  /danger-full-access/i,
  /factory\.authorize\./i,
  /cargo\s+publish/i,
  /git\s+push/i,
  /git\s+tag/i,
  /deploy\s+release/i,
  /\brelease\b.*\bpublish\b/i,
  /cache\s+prune/i,
  /learn\s+record/i,
  /daemon\s+start/i,
  /fabric\s+--serve/i,
  /rm\s+-rf\s+\//i,
];

const GATE_PATTERNS = [
  /\bship\b/i,
  /\bdeploy\b/i,
  /\brestart\b/i,
  /\bwrite-chars\b/i,
  /\bzellij\s+pipe\b/i,
  /network[- ]enabled/i,
  /workspace[-_ ]write/i,
  /npm\s+audit\s+fix/i,
  /npm\s+install\b/i,
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

export function classifyPermission(input: PermissionClassificationInput): PermissionClassification {
  const subject = [input.objective, input.command ?? "", input.path ?? "", ...(input.declaredPermissions ?? [])].join("\n");
  const declaredPermissions = input.declaredPermissions ?? [];
  const observedEffects = input.observedEffects ?? [];

  const pathViolation = input.path ? classifyPath(input.cwd, input.path) : null;
  if (pathViolation?.class === "BLOCK") {
    return {
      class: "BLOCK",
      reason: pathViolation.reason,
      declaredPermissions,
      observedEffects,
      permissionDelta: observedEffects.length > 0 ? "violation" : "none",
    };
  }

  if (BLOCK_PATTERNS.some((pattern) => pattern.test(subject))) {
    return { class: "BLOCK", reason: "matches armed/destructive forbidden transition", declaredPermissions, observedEffects, permissionDelta: observedEffects.length > 0 ? "violation" : "none" };
  }
  if (GATE_PATTERNS.some((pattern) => pattern.test(subject))) {
    return { class: "GATE", reason: "requires explicit gate/arming under S1008820", declaredPermissions, observedEffects, permissionDelta: observedEffects.length > 0 ? "unknown" : "none" };
  }
  if (declaredPermissions.includes("write")) {
    return { class: "DEFER", reason: "workspace write is deferred until safety and receipt gates pass", declaredPermissions, observedEffects, permissionDelta: observedEffects.length > 0 ? "expected" : "none" };
  }
  if (READ_ONLY_PATTERNS.some((pattern) => pattern.test(subject))) {
    return { class: "AUTO", reason: "read-only/offline diagnostic or review action", declaredPermissions, observedEffects, permissionDelta: observedEffects.length > 0 ? "violation" : "none" };
  }
  return { class: "DEFER", reason: "unclassified intent defaults to DEFER", declaredPermissions, observedEffects, permissionDelta: observedEffects.length > 0 ? "unknown" : "none" };
}

function classifyPath(cwd: string, candidate: string): { class: SafetyClass; reason: string } {
  const resolved = isAbsolute(candidate) ? normalize(candidate) : resolve(cwd, candidate);
  const rel = relative(cwd, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { class: "BLOCK", reason: `outside-workspace path refused: ${candidate}` };
  }
  if (rel === ".morph" || rel.startsWith(`.morph/`)) {
    return { class: "BLOCK", reason: "root .morph clobber is blocked" };
  }
  if (rel.startsWith(".git/") || rel === ".git") {
    return { class: "BLOCK", reason: ".git mutation is blocked" };
  }
  return { class: "AUTO", reason: "path is inside workspace" };
}

export function reconcileObservedEffects(declared: string[], observed: string[]): PermissionClassification["permissionDelta"] {
  if (observed.length === 0) return "none";
  const undeclared = observed.filter((effect) => !declared.includes(effect));
  return undeclared.length === 0 ? "expected" : "violation";
}
