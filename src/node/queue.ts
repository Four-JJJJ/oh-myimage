import { Queue } from "bullmq";
import IORedis from "ioredis";
import type { AppQueue, GenerationMessage, InspirationQueueMessage } from "../worker/types";

export const GENERATION_QUEUE_NAME = process.env.BULLMQ_GENERATION_QUEUE_NAME ?? "oh-myimage-generation";
export const INSPIRATION_QUEUE_NAME = process.env.BULLMQ_INSPIRATION_QUEUE_NAME ?? "oh-myimage-inspiration";

export interface QueueConfig {
  redisUrl: string;
  generationAttempts: number;
  generationBackoffMs: number;
}

export interface BullQueues {
  generationQueue: AppQueue<GenerationMessage>;
  inspirationQueue: AppQueue<InspirationQueueMessage>;
  close(): Promise<void>;
}

export function createRedisConnection(redisUrl: string): IORedis {
  return new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

export function createBullQueues(config: QueueConfig): BullQueues {
  const connection = createRedisConnection(config.redisUrl);
  const generation = new Queue<GenerationMessage>(GENERATION_QUEUE_NAME, { connection });
  const inspiration = new Queue<InspirationQueueMessage>(INSPIRATION_QUEUE_NAME, { connection });

  return {
    generationQueue: new BullAppQueue(generation, "generation", {
      attempts: config.generationAttempts,
      backoff: { type: "fixed", delay: config.generationBackoffMs },
    }),
    inspirationQueue: new BullAppQueue(inspiration, "inspiration", {
      attempts: 1,
    }),
    async close() {
      await Promise.all([generation.close(), inspiration.close()]);
      connection.disconnect();
    },
  };
}

class BullAppQueue<T> implements AppQueue<T> {
  constructor(
    private readonly queue: Queue,
    private readonly name: string,
    private readonly defaults: { attempts: number; backoff?: { type: "fixed"; delay: number } },
  ) {}

  async send(message: T): Promise<void> {
    await this.queue.add(this.name, message, {
      attempts: this.defaults.attempts,
      backoff: this.defaults.backoff,
      removeOnComplete: 1_000,
      removeOnFail: 5_000,
    });
  }
}
