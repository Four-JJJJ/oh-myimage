import type { GenerationJob } from "./api";

export function claimGenerationSubmitLock(lock: { current: boolean }): boolean {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function releaseGenerationSubmitLock(lock: { current: boolean }): void {
  lock.current = false;
}

export function isTerminalGenerationJobStatus(status: GenerationJob["status"]): boolean {
  return status === "succeeded" || status === "partial_succeeded" || status === "failed" || status === "cancelled";
}

export function mergePolledJobState(
  current: Pick<GenerationJob, "id" | "status" | "completed_at"> | null | undefined,
  incoming: GenerationJob,
): GenerationJob {
  if (!current || current.id !== incoming.id) return incoming;
  if (isTerminalGenerationJobStatus(current.status) && !isTerminalGenerationJobStatus(incoming.status)) return { ...incoming, ...current };

  const currentCompletedAt = parseJobTimestamp(current.completed_at);
  const incomingCompletedAt = parseJobTimestamp(incoming.completed_at);
  if (currentCompletedAt !== null && incomingCompletedAt !== null && incomingCompletedAt < currentCompletedAt) {
    return { ...incoming, ...current };
  }

  return incoming;
}

function parseJobTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
