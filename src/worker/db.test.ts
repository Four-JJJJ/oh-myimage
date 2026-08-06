import { afterEach, describe, expect, it, vi } from "vitest";
import {
  countDailyGeneratedImages,
  countDailyImageUsage,
  countPendingGenerationImages,
  GENERATION_JOB_PAGE_SIZE,
  IMAGE_GENERATED_EVENT,
  insertImageUsageEvent,
  insertImageAsset,
  listGenerationJobs,
  listGenerationResultsForJob,
  upsertGenerationJobResult,
} from "./db";
import type { AppDatabase, AppPreparedStatement } from "./types";

interface DbCall {
  query: string;
  values: unknown[];
  method: "first" | "all" | "run";
}

class FakeDatabase implements AppDatabase {
  readonly calls: DbCall[] = [];

  constructor(
    private readonly firstRows: unknown[] = [],
    private readonly runErrors: Array<unknown | null> = [],
  ) {}

  prepare(query: string): AppPreparedStatement {
    return new FakePreparedStatement(this, query);
  }

  nextFirstRow(): unknown {
    return this.firstRows.shift() ?? null;
  }

  nextRunError(): unknown | null {
    return this.runErrors.shift() ?? null;
  }
}

class FakePreparedStatement implements AppPreparedStatement {
  private values: unknown[] = [];

  constructor(
    private readonly db: FakeDatabase,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): AppPreparedStatement {
    this.values = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    this.db.calls.push({ query: this.query, values: this.values, method: "first" });
    return this.db.nextFirstRow() as T | null;
  }

  async all<T = unknown>(): Promise<{ results?: T[] }> {
    this.db.calls.push({ query: this.query, values: this.values, method: "all" });
    return { results: [] };
  }

  async run(): Promise<unknown> {
    this.db.calls.push({ query: this.query, values: this.values, method: "run" });
    const error = this.db.nextRunError();
    if (error) throw error;
    return { success: true };
  }
}

describe("daily image usage accounting", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts generated images from usage events and image assets missing events", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T08:30:00.000Z"));
    const db = new FakeDatabase([{ count: "3" }]);

    await expect(countDailyGeneratedImages(db, "space_1")).resolves.toBe(3);

    expect(db.calls[0]?.query).toContain("rate_limit_events");
    expect(db.calls[0]?.query).toContain("image_assets");
    expect(db.calls[0]?.query).toContain("evt_usage_");
    expect(db.calls[0]?.values).toEqual([
      "space_1",
      IMAGE_GENERATED_EVENT,
      "2026-05-15 00:00:00",
      "space_1",
      "2026-05-15 00:00:00",
    ]);
  });

  it("reserves unfinished images from active generation jobs", async () => {
    const db = new FakeDatabase([{ count: 2 }]);

    await expect(countPendingGenerationImages(db, "space_1")).resolves.toBe(2);

    expect(db.calls[0]?.query).toContain("WITH active_jobs AS");
    expect(db.calls[0]?.query).toContain("generation_jobs.status IN ('queued', 'running')");
    expect(db.calls[0]?.query).toContain("image_assets.job_id = active_jobs.id");
    expect(db.calls[0]?.query).toContain("active_jobs.quantity - COALESCE(image_counts.image_count, 0)");
    expect(db.calls[0]?.values).toEqual(["space_1"]);
  });

  it("combines generated usage events and pending reservations", async () => {
    const db = new FakeDatabase([{ count: 4 }, { count: "2" }]);

    await expect(countDailyImageUsage(db, "space_1")).resolves.toEqual({
      generated: 4,
      pending: 2,
      total: 6,
    });
  });

  it("records image usage with a deterministic event id", async () => {
    const db = new FakeDatabase();

    await insertImageUsageEvent(db, "space_1", "img_abc");

    expect(db.calls[0]).toMatchObject({
      method: "run",
      values: ["evt_usage_img_abc", "space_1", IMAGE_GENERATED_EVENT],
    });
    expect(db.calls[0]?.query).toContain("ON CONFLICT (id) DO NOTHING");
  });
});

describe("image persistence idempotency", () => {
  it("upserts a deterministic image asset so local recovery can be replayed safely", async () => {
    const db = new FakeDatabase();

    await insertImageAsset(db, {
      id: "img_job_1_0",
      space_id: "space_1",
      job_id: "job_1",
      storage_key: "space_1/job_1/img_job_1_0.png",
      mime_type: "image/png",
      format: "png",
      width: 1024,
      height: 1024,
      byte_size: 8,
      sha256: "sha",
      thumbnail_storage_key: null,
      thumbnail_mime_type: null,
      thumbnail_byte_size: null,
      thumbnail_sha256: null,
    });

    expect(db.calls[0]?.query).toContain("ON CONFLICT (id) DO UPDATE");
    expect(db.calls[0]?.query).toContain("COALESCE(excluded.thumbnail_storage_key");
  });

  it("falls back to the original-image columns only when the thumbnail migration is temporarily missing", async () => {
    const db = new FakeDatabase([], [new Error('column "thumbnail_storage_key" of relation "image_assets" does not exist'), null]);

    await insertImageAsset(db, {
      id: "img_job_1_0",
      space_id: "space_1",
      job_id: "job_1",
      storage_key: "space_1/job_1/img_job_1_0.png",
      mime_type: "image/png",
      format: "png",
      width: 1024,
      height: 1024,
      byte_size: 8,
      sha256: "sha",
      thumbnail_storage_key: "space_1/job_1/thumb_img_job_1_0.webp",
      thumbnail_mime_type: "image/webp",
      thumbnail_byte_size: 4,
      thumbnail_sha256: "thumb-sha",
    });

    expect(db.calls).toHaveLength(2);
    expect(db.calls[0]?.query).toContain("thumbnail_storage_key");
    expect(db.calls[1]?.query).not.toContain("thumbnail_storage_key");
    expect(db.calls[1]?.values).toHaveLength(10);
  });

  it("does not hide unrelated image-asset insert errors", async () => {
    const error = new Error("database connection lost");
    const db = new FakeDatabase([], [error]);

    await expect(
      insertImageAsset(db, {
        id: "img_job_1_0",
        space_id: "space_1",
        job_id: "job_1",
        storage_key: "space_1/job_1/img_job_1_0.png",
        mime_type: "image/png",
        format: "png",
        width: 1024,
        height: 1024,
        byte_size: 8,
        sha256: "sha",
        thumbnail_storage_key: null,
        thumbnail_mime_type: null,
        thumbnail_byte_size: null,
        thumbnail_sha256: null,
      }),
    ).rejects.toBe(error);
    expect(db.calls).toHaveLength(1);
  });
});

describe("generation job pagination", () => {
  it("loads one extra generation job so callers can detect more than one visible page", async () => {
    const db = new FakeDatabase();

    await listGenerationJobs(db, "space_1");

    expect(db.calls[0]?.query).toContain(`LIMIT ${GENERATION_JOB_PAGE_SIZE + 1}`);
    expect(db.calls[0]?.values).toEqual(["space_1"]);
  });
});

describe("generation job result slots", () => {
  it("upserts per-image generation results with stable slot identity", async () => {
    const db = new FakeDatabase();

    await upsertGenerationJobResult(db, {
      id: "res_job_1_0",
      space_id: "space_1",
      job_id: "job_1",
      result_index: 0,
      status: "failed",
      image_asset_id: null,
      error_code: "provider_timeout",
      error_message: "模型服务超时",
      started_at: "2026-05-15T00:00:00.000Z",
      completed_at: "2026-05-15T00:01:00.000Z",
    });

    expect(db.calls[0]?.method).toBe("run");
    expect(db.calls[0]?.query).toContain("INSERT INTO generation_job_results");
    expect(db.calls[0]?.query).toContain("ON CONFLICT");
    expect(db.calls[0]?.values).toEqual([
      "res_job_1_0",
      "space_1",
      "job_1",
      0,
      "failed",
      null,
      "provider_timeout",
      "模型服务超时",
      "2026-05-15T00:00:00.000Z",
      "2026-05-15T00:01:00.000Z",
    ]);
  });

  it("lists generation result slots in index order", async () => {
    const db = new FakeDatabase();

    await listGenerationResultsForJob(db, "space_1", "job_1");

    expect(db.calls[0]?.method).toBe("all");
    expect(db.calls[0]?.query).toContain("FROM generation_job_results");
    expect(db.calls[0]?.query).toContain("ORDER BY result_index ASC");
    expect(db.calls[0]?.values).toEqual(["space_1", "job_1"]);
  });
});
