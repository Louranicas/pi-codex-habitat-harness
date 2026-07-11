import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RunEnvelope } from "./run-envelope.js";

export interface ActorBridgeStatus {
  codexSdk: BridgeReadiness;
  agentsTs: BridgeReadiness;
  agentsPy: BridgeReadiness;
}

export interface BridgeReadiness {
  state: "live_ready" | "offline_fixture_ready" | "missing_dependency" | "auth_missing";
  authState: RunEnvelope["authState"];
  liveCallState: RunEnvelope["liveCallState"];
  fixtureState: "present" | "missing";
  notes: string[];
}

export function actorBridgeStatus(cwd: string): ActorBridgeStatus {
  const authPresent = Boolean(process.env.OPENAI_API_KEY);
  return {
    codexSdk: bridge({ authPresent, fixturePresent: existsSync(join(cwd, "pi-codex-habitat-harness", "fixtures", "codex-events", "success.jsonl")), name: "Codex SDK" }),
    agentsTs: bridge({ authPresent, fixturePresent: existsSync(join(cwd, "pi-codex-habitat-harness", "fixtures", "agents-runs", "success.json")), name: "OpenAI Agents TS" }),
    agentsPy: bridge({ authPresent, fixturePresent: existsSync(join(cwd, ".venv")), name: "OpenAI Agents Python" }),
  };
}

function bridge(input: { authPresent: boolean; fixturePresent: boolean; name: string }): BridgeReadiness {
  if (input.authPresent) {
    return {
      state: "live_ready",
      authState: "present",
      liveCallState: "not_required",
      fixtureState: input.fixturePresent ? "present" : "missing",
      notes: [`${input.name} may attempt live calls only when an explicit live-run command is invoked.`],
    };
  }
  return {
    state: input.fixturePresent ? "offline_fixture_ready" : "auth_missing",
    authState: "missing",
    liveCallState: "skipped",
    fixtureState: input.fixturePresent ? "present" : "missing",
    notes: [`${input.name} live calls skipped because OPENAI_API_KEY is missing.`],
  };
}
