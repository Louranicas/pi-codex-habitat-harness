import http from "node:http";
import type { HabitatObservation } from "./habitat-observation.js";

export interface ExternalAck {
  substrate: "povm";
  endpoint: "POST /memories";
  ok: boolean;
  statusCode: number | null;
  id: string | null;
  error: string | null;
}

export async function circulateReceiptToPovm(eventHash: string, observation: HabitatObservation): Promise<ExternalAck> {
  const body = JSON.stringify({
    namespace: "codex-pi-harness",
    session_id: "s1008820",
    content: [
      "Codex Pi Harness habitat-observed receipt ACK",
      `event_hash=${eventHash}`,
      `observed_at=${observation.observedAt}`,
      `healthy_services=${observation.liveServices.filter((service) => service.probeState === "healthy").length}/${observation.liveServices.length}`,
      `gates=${JSON.stringify(observation.gates)}`,
    ].join("\n"),
    theta: 0,
    phi: 0,
    tensor: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  });

  return await new Promise((resolve) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: 8125,
        path: "/memories",
        method: "POST",
        timeout: 1_500,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => {
          let id: string | null = null;
          try {
            const parsed = JSON.parse(text) as { id?: unknown };
            id = typeof parsed.id === "string" ? parsed.id : null;
          } catch {
            id = null;
          }
          const ok = Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 300 && id);
          resolve({ substrate: "povm", endpoint: "POST /memories", ok, statusCode: res.statusCode ?? null, id, error: ok ? null : text.slice(0, 200) });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ substrate: "povm", endpoint: "POST /memories", ok: false, statusCode: null, id: null, error: "timeout" });
    });
    req.on("error", (error) => resolve({ substrate: "povm", endpoint: "POST /memories", ok: false, statusCode: null, id: null, error: error.message }));
    req.write(body);
    req.end();
  });
}
