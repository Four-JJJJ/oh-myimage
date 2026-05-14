import { Worker } from "bullmq";
import { createNodeRuntime } from "./env";
import { createRedisConnection, GENERATION_QUEUE_NAME, INSPIRATION_QUEUE_NAME } from "./queue";
import { processInspirationSourceMessage } from "../worker/inspiration";
import { resolveProviderRetryAttempts } from "../worker/index";
import { processGenerationMessage } from "../worker/provider";
import type { GenerationMessage, InspirationQueueMessage } from "../worker/types";

const runtime = createNodeRuntime({ queues: false });
const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const generationConnection = createRedisConnection(redisUrl);
const inspirationConnection = createRedisConnection(redisUrl);
const maxRetryAttempts = resolveProviderRetryAttempts(runtime.env.PROVIDER_RETRY_ATTEMPTS);
const generationConcurrency = Math.max(1, Number(process.env.NODE_GENERATION_WORKER_CONCURRENCY ?? 10));

const generationWorker = new Worker<GenerationMessage>(
  GENERATION_QUEUE_NAME,
  async (job) => {
    const canRetryProviderError = job.attemptsMade < maxRetryAttempts;
    await processGenerationMessage(job.data, runtime.env, { throwRetryableErrors: canRetryProviderError });
  },
  {
    connection: generationConnection,
    concurrency: generationConcurrency,
    lockDuration: 120_000,
  },
);

const inspirationWorker = new Worker<InspirationQueueMessage>(
  INSPIRATION_QUEUE_NAME,
  async (job) => {
    await processInspirationSourceMessage(job.data, runtime.env);
  },
  {
    connection: inspirationConnection,
    concurrency: Math.max(1, Number(process.env.NODE_INSPIRATION_WORKER_CONCURRENCY ?? 1)),
    lockDuration: 120_000,
  },
);

generationWorker.on("failed", (job, error) => {
  console.error("generation job failed", JSON.stringify({ id: job?.id, attemptsMade: job?.attemptsMade, error: error.message }));
});

inspirationWorker.on("failed", (job, error) => {
  console.error("inspiration job failed", JSON.stringify({ id: job?.id, attemptsMade: job?.attemptsMade, error: error.message }));
});

console.log("oh-myimage workers started", JSON.stringify({ generationConcurrency, maxRetryAttempts }));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

async function shutdown(signal: string): Promise<void> {
  console.log(`received ${signal}, shutting down workers`);
  await Promise.all([generationWorker.close(), inspirationWorker.close()]);
  generationConnection.disconnect();
  inspirationConnection.disconnect();
  await runtime.close();
  process.exit(0);
}
