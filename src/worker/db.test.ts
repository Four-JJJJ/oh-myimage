import { afterEach, describe, expect, it, vi } from "vitest";
import {
  countDailyGeneratedImages,
  countDailyImageUsage,
  countPendingGenerationImages,
  IMAGE_GENERATED_EVENT,
  insertImageUsageEvent,
} from "./db";
import type { AppDatabase, AppPreparedStatement } from "./types";

interface DbCall {
  query: string;
  values: unknown[];
  method: "first" | "all" | "run";
}

class FakeDatabase implements AppDatabase {
  readonly calls: DbCall[] = [];

  constructor(private readonly firstRows: unknown[] = []) {}

  prepare(query: string): AppPreparedStatement {
    return new FakePreparedStatement(this, query);
  }

  nextFirstRow(): unknown {
    return this.firstRows.shift() ?? null;
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
    return { success: true };
  }
}

describe("daily image usage accounting", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts generated images from usage events using database timestamp format", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T08:30:00.000Z"));
    const db = new FakeDatabase([{ count: "3" }]);

    await expect(countDailyGeneratedImages(db, "space_1")).resolves.toBe(3);

    expect(db.calls[0]?.query).toContain("rate_limit_events");
    expect(db.calls[0]?.values).toEqual(["space_1", IMAGE_GENERATED_EVENT, "2026-05-15 00:00:00"]);
  });

  it("reserves unfinished images from active generation jobs", async () => {
    const db = new FakeDatabase([{ count: 2 }]);

    await expect(countPendingGenerationImages(db, "space_1")).resolves.toBe(2);

    expect(db.calls[0]?.query).toContain("generation_jobs.status IN ('queued', 'running')");
    expect(db.calls[0]?.query).toContain("generation_jobs.quantity - COALESCE(image_counts.image_count, 0)");
    expect(db.calls[0]?.values).toEqual(["space_1", "space_1"]);
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
  });
});
