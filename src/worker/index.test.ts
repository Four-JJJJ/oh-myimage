import { describe, expect, it } from "vitest";
import { app, hasUnlimitedDailyImageQuota } from "./index";
import type { AppDatabase, AppObject, AppObjectStore, AppObjectStorePutOptions, AppPreparedStatement, Env } from "./types";

describe("daily image quota exemption", () => {
  it("exempts Small Token providers without requiring a connection test", () => {
    expect(hasUnlimitedDailyImageQuota({ base_url: "https://token.fourj.space/v1" })).toBe(true);
    expect(hasUnlimitedDailyImageQuota({ base_url: "https://image.fourj.space/v1" })).toBe(true);
  });

  it("does not exempt other provider URLs", () => {
    expect(hasUnlimitedDailyImageQuota({ base_url: "https://api.openai.com/v1" })).toBe(false);
  });
});

describe("image downloads", () => {
  it("returns same-origin original image bytes for explicit downloads", async () => {
    const images = new FakeObjectStore();
    const response = await app.request(
      "http://local.test/api/images/img_1/download?raw=1&download=1",
      {
        headers: { Cookie: "image2_session=test-token" },
      },
      testEnv({ images }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="img_1.png"');
    expect(response.headers.get("Location")).toBeNull();
    expect(await response.text()).toBe("image-bytes");
    expect(images.getCalls).toEqual(["space_1/img_1.png"]);
    expect(images.presignedCalls).toEqual([]);
  });

  it("keeps raw image reads inline when no download flag is set", async () => {
    const images = new FakeObjectStore();
    const response = await app.request(
      "http://local.test/api/images/img_1/download?raw=1",
      {
        headers: { Cookie: "image2_session=test-token" },
      },
      testEnv({ images }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Content-Disposition")).toBe('inline; filename="img_1.png"');
    expect(response.headers.get("Location")).toBeNull();
    expect(await response.text()).toBe("image-bytes");
    expect(images.getCalls).toEqual(["space_1/img_1.png"]);
    expect(images.presignedCalls).toEqual([]);
  });

  it("keeps normal downloads on the presigned redirect path", async () => {
    const images = new FakeObjectStore({ presignedUrl: "https://r2.example.com/signed-img" });
    const response = await app.request(
      "http://local.test/api/images/img_1/download",
      {
        headers: { Cookie: "image2_session=test-token" },
      },
      testEnv({ images }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://r2.example.com/signed-img");
    expect(images.getCalls).toEqual([]);
    expect(images.presignedCalls).toEqual(["space_1/img_1.png"]);
  });
});

function testEnv({ images }: { images: AppObjectStore }): Env {
  return {
    DB: new FakeRouteDatabase(),
    IMAGES: images,
    GENERATION_QUEUE: disabledQueue(),
    INSPIRATION_QUEUE: disabledQueue(),
  };
}

function disabledQueue() {
  return {
    async send(): Promise<void> {
      throw new Error("Queue is not expected in this test.");
    },
  };
}

class FakeRouteDatabase implements AppDatabase {
  prepare(query: string): AppPreparedStatement {
    return new FakeRoutePreparedStatement(query);
  }
}

class FakeRoutePreparedStatement implements AppPreparedStatement {
  private values: unknown[] = [];

  constructor(private readonly query: string) {}

  bind(...values: unknown[]): AppPreparedStatement {
    this.values = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    if (this.query.includes("FROM space_sessions")) {
      return {
        id: "ses_1",
        space_id: "space_1",
        token_hash: String(this.values[0] ?? ""),
        expires_at: "2099-01-01T00:00:00.000Z",
        created_at: "2026-05-15T00:00:00.000Z",
        space_name: "Test Space",
        space_key: "test-space",
        password_hash: "hash",
        updated_at: "2026-05-15T00:00:00.000Z",
      } as T;
    }
    if (this.query.includes("FROM image_assets")) {
      return {
        id: "img_1",
        space_id: "space_1",
        job_id: "job_1",
        storage_key: "space_1/img_1.png",
        mime_type: "image/png",
        format: "png",
        width: 1024,
        height: 1024,
        byte_size: 11,
        sha256: "sha",
        created_at: "2026-05-15T00:00:00.000Z",
      } as T;
    }
    return null;
  }

  async all<T = unknown>(): Promise<{ results?: T[] }> {
    return { results: [] };
  }

  async run(): Promise<unknown> {
    return { success: true };
  }
}

class FakeObjectStore implements AppObjectStore {
  readonly getCalls: string[] = [];
  readonly presignedCalls: string[] = [];

  constructor(private readonly options: { presignedUrl?: string } = {}) {}

  async put(
    _key: string,
    _value: ArrayBuffer | ArrayBufferView | Blob | ReadableStream | string,
    _options?: AppObjectStorePutOptions,
  ): Promise<unknown> {
    return {};
  }

  async get(key: string): Promise<AppObject | null> {
    this.getCalls.push(key);
    return {
      body: new Blob(["image-bytes"], { type: "image/png" }).stream(),
      httpMetadata: { contentType: "image/png" },
      async arrayBuffer() {
        return new TextEncoder().encode("image-bytes").buffer;
      },
    };
  }

  async delete(_key: string): Promise<void> {}

  async createPresignedGetUrl(key: string): Promise<string> {
    this.presignedCalls.push(key);
    if (!this.options.presignedUrl) throw new Error("Presigned URL is not configured.");
    return this.options.presignedUrl;
  }
}
