export interface DisposableAbortSignal {
  signal: AbortSignal;
  dispose: () => void;
}

export function createTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): DisposableAbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  const onAbort = () => controller.abort(parent?.reason ?? new Error("aborted"));

  if (parent) {
    if (parent.aborted) onAbort();
    else parent.addEventListener("abort", onAbort, { once: true });
  }
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}
