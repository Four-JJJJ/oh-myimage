import type { GenerationJob } from "./api";

const TERMINAL_OUTCOME_STATUSES = new Set<GenerationJob["status"]>(["succeeded", "partial_succeeded", "failed"]);

export function generationProgressSummary(job: GenerationJob, fallbackSucceededCount = 0): string {
  const total = Math.max(1, job.progress_total ?? job.quantity);
  const results = job.results ?? [];
  const hasResultDetails = results.length > 0;
  const succeededFromResults = results.filter((result) => result.status === "succeeded").length;
  const failedFromResults = results.filter((result) => result.status === "failed").length;
  const fallbackSucceeded = Math.min(Math.max(0, fallbackSucceededCount), total);

  if (TERMINAL_OUTCOME_STATUSES.has(job.status)) {
    const succeeded = hasResultDetails
      ? succeededFromResults
      : job.status === "succeeded"
        ? total
        : fallbackSucceeded;
    const failed = hasResultDetails
      ? failedFromResults
      : job.status === "succeeded"
        ? 0
        : Math.max(0, total - succeeded);
    return `成功 ${Math.min(succeeded, total)}/${total} · 失败 ${Math.min(failed, total)}/${total}`;
  }

  const processedFromResults = succeededFromResults + failedFromResults;
  const processed = job.progress_current ?? processedFromResults;
  return `已处理 ${Math.min(Math.max(0, processed), total)}/${total}`;
}
