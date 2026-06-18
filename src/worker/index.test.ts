import { describe, expect, it } from "vitest";
import { hashPassword } from "./crypto";
import { app, hasUnlimitedDailyImageQuota, resolveProviderRetryAttempts } from "./index";
import type { AppDatabase, AppObject, AppObjectStore, AppObjectStorePutOptions, AppPreparedStatement, Env, ImageAssetRecord, SpaceRecord } from "./types";

describe("daily image quota exemption", () => {
  it("no longer exempts any provider by URL", () => {
    expect(hasUnlimitedDailyImageQuota({ base_url: "https://token.fourj.space/v1" })).toBe(false);
    expect(hasUnlimitedDailyImageQuota({ base_url: "https://image.fourj.space/v1" })).toBe(false);
  });

  it("keeps regular provider URLs non-exempt", () => {
    expect(hasUnlimitedDailyImageQuota({ base_url: "https://api.openai.com/v1" })).toBe(false);
  });
});

describe("provider queue retry attempts", () => {
  it("defaults to no automatic requeue retries", () => {
    expect(resolveProviderRetryAttempts(undefined)).toBe(0);
  });

  it("still allows explicit retry configuration within bounds", () => {
    expect(resolveProviderRetryAttempts("2")).toBe(2);
    expect(resolveProviderRetryAttempts("99")).toBe(4);
  });
});

describe("image downloads", () => {
  it("uses stable same-origin image URLs for generation records", async () => {
    const db = new FakeRouteDatabase();
    db.jobRecords.set("job_1", makeJobRecord());
    const response = await app.request(
      "http://local.test/api/generations",
      {
        headers: { Cookie: "image2_session=test-token" },
      },
      testEnv({ db, images: new FakeObjectStore() }),
    );
    const json = (await response.json()) as { records: Array<{ images: Array<{ url: string }> }> };

    expect(response.status).toBe(200);
    expect(json.records[0]?.images[0]?.url).toBe("/api/images/img_1/download?raw=1");
  });

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
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
    expect(response.headers.get("ETag")).toBe('"sha"');
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

  it("returns not modified for cached same-origin image reads", async () => {
    const images = new FakeObjectStore();
    const response = await app.request(
      "http://local.test/api/images/img_1/download?raw=1",
      {
        headers: { Cookie: "image2_session=test-token", "If-None-Match": '"sha"' },
      },
      testEnv({ images }),
    );

    expect(response.status).toBe(304);
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
    expect(response.headers.get("ETag")).toBe('"sha"');
    expect(await response.text()).toBe("");
    expect(images.getCalls).toEqual([]);
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

describe("generation creation", () => {
  it("stores reference and mask images before enqueueing edit generation jobs", async () => {
    const db = new FakeRouteDatabase();
    const images = new FakeObjectStore();
    const generationQueue = new RecordingQueue();
    const formData = new FormData();
    formData.set("prompt", "edit the selected area");
    formData.set("aspectRatio", "1:1");
    formData.set("width", "1024");
    formData.set("height", "1024");
    formData.set("quality", "auto");
    formData.set("quantity", "2");
    formData.set("outputFormat", "png");
    formData.set("compression", "100");
    formData.set("referenceImage", new File(["reference-bytes"], "source.png", { type: "image/png" }));
    formData.set("maskImage", new File(["mask-bytes"], "source-mask.png", { type: "image/png" }));

    const response = await app.request(
      "http://local.test/api/generations",
      {
        method: "POST",
        headers: { Cookie: "image2_session=test-token" },
        body: formData,
      },
      testEnv({ db, images, generationQueue }),
    );
    const json = (await response.json()) as { ok: true; jobId: string; status: "queued" };

    expect(response.status).toBe(200);
    expect(json.status).toBe("queued");
    expect(generationQueue.messages).toEqual([{ jobId: json.jobId, spaceId: "space_1" }]);
    expect(images.putCalls.map((call) => call.key)).toEqual([
      `space_1/${json.jobId}/reference-1.png`,
      `space_1/${json.jobId}/mask.png`,
    ]);
    expect(images.putCalls.map((call) => call.options?.customMetadata?.kind)).toEqual(["reference", "mask"]);
    expect(db.generationJobInserts).toHaveLength(1);
    expect(db.generationJobInserts[0]).toEqual(
      expect.arrayContaining([
        json.jobId,
        "space_1",
        "edit the selected area",
        "space_1",
        `space_1/${json.jobId}/reference-1.png`,
        `space_1/${json.jobId}/mask.png`,
      ]),
    );
  });

  it("stores multiple reference image snapshots before enqueueing edit generation jobs", async () => {
    const db = new FakeRouteDatabase();
    const images = new FakeObjectStore();
    const generationQueue = new RecordingQueue();
    const formData = new FormData();
    formData.set("prompt", "blend the references");
    formData.set("aspectRatio", "1:1");
    formData.set("width", "1024");
    formData.set("height", "1024");
    formData.set("quality", "auto");
    formData.set("quantity", "1");
    formData.set("outputFormat", "png");
    formData.set("compression", "100");
    formData.append("referenceImage", new File(["reference-one"], "source-one.png", { type: "image/png" }));
    formData.append("referenceImage", new File(["reference-two"], "source-two.webp", { type: "image/webp" }));

    const response = await app.request(
      "http://local.test/api/generations",
      {
        method: "POST",
        headers: { Cookie: "image2_session=test-token" },
        body: formData,
      },
      testEnv({ db, images, generationQueue }),
    );
    const json = (await response.json()) as { ok: true; jobId: string; status: "queued" };

    expect(response.status).toBe(200);
    expect(generationQueue.messages).toEqual([{ jobId: json.jobId, spaceId: "space_1" }]);
    expect(images.putCalls.map((call) => call.key)).toEqual([
      `space_1/${json.jobId}/reference-1.png`,
      `space_1/${json.jobId}/reference-2.webp`,
    ]);
    expect(images.putCalls.map((call) => call.options?.customMetadata?.referenceIndex)).toEqual(["1", "2"]);
    expect(db.generationJobInserts[0]).toEqual(
      expect.arrayContaining([
        json.jobId,
        "space_1",
        "blend the references",
        "space_1",
        `space_1/${json.jobId}/reference-1.png`,
      ]),
    );
    expect(JSON.parse(String(db.generationJobInserts[0]?.at(-1)))).toEqual([
      expect.objectContaining({ storageKey: `space_1/${json.jobId}/reference-1.png`, name: "source-one.png", mimeType: "image/png" }),
      expect.objectContaining({ storageKey: `space_1/${json.jobId}/reference-2.webp`, name: "source-two.webp", mimeType: "image/webp" }),
    ]);
  });

  it("copies source images before enqueueing edit generation jobs", async () => {
    const db = new FakeRouteDatabase();
    const images = new FakeObjectStore();
    const generationQueue = new RecordingQueue();

    const response = await app.request(
      "http://local.test/api/generations",
      {
        method: "POST",
        headers: { Cookie: "image2_session=test-token", "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "edit from existing image",
          aspectRatio: "1:1",
          width: 1024,
          height: 1024,
          quality: "auto",
          quantity: 1,
          outputFormat: "png",
          compression: 100,
          sourceImageId: "img_1",
        }),
      },
      testEnv({ db, images, generationQueue }),
    );
    const json = (await response.json()) as { ok: true; jobId: string; status: "queued" };

    expect(response.status).toBe(200);
    expect(json.status).toBe("queued");
    expect(generationQueue.messages).toEqual([{ jobId: json.jobId, spaceId: "space_1" }]);
    expect(images.copyCalls.map((call) => [call.sourceKey, call.destinationKey])).toEqual([["space_1/img_1.png", `space_1/${json.jobId}/reference-1.png`]]);
    expect(images.putCalls).toEqual([]);
    expect(db.generationJobInserts[0]).toEqual(
      expect.arrayContaining([
        json.jobId,
        "space_1",
        "edit from existing image",
        "space_1",
        `space_1/${json.jobId}/reference-1.png`,
      ]),
    );
  });

  it("reuses the selected conversation id for continued prompts", async () => {
    const db = new FakeRouteDatabase();
    db.jobRecords.set("job_root", makeJobRecord({ id: "job_root", conversation_id: "job_root", prompt: "第一次创作" }));

    const response = await app.request(
      "http://local.test/api/generations",
      {
        method: "POST",
        headers: { Cookie: "image2_session=test-token", "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "继续补充细节",
          aspectRatio: "1:1",
          width: 1024,
          height: 1024,
          quality: "auto",
          quantity: 1,
          outputFormat: "png",
          compression: 100,
          conversationId: "job_root",
        }),
      },
      testEnv({ db, images: new FakeObjectStore(), generationQueue: new RecordingQueue() }),
    );
    const json = (await response.json()) as { ok: true; jobId: string; status: "queued" };

    expect(response.status).toBe(200);
    expect(db.generationJobInserts[0]).toEqual(
      expect.arrayContaining([
        json.jobId,
        "space_1",
        "继续补充细节",
        "space_1",
        "job_root",
      ]),
    );
  });

  it("stores masks while copying source images for selected-area edits", async () => {
    const db = new FakeRouteDatabase();
    const images = new FakeObjectStore();
    const generationQueue = new RecordingQueue();
    const formData = new FormData();
    formData.set("prompt", "edit selected area from existing image");
    formData.set("aspectRatio", "1:1");
    formData.set("width", "1024");
    formData.set("height", "1024");
    formData.set("quality", "auto");
    formData.set("quantity", "1");
    formData.set("outputFormat", "png");
    formData.set("compression", "100");
    formData.set("sourceImageId", "img_1");
    formData.set("maskImage", new File(["mask-bytes"], "source-mask.png", { type: "image/png" }));

    const response = await app.request(
      "http://local.test/api/generations",
      {
        method: "POST",
        headers: { Cookie: "image2_session=test-token" },
        body: formData,
      },
      testEnv({ db, images, generationQueue }),
    );
    const json = (await response.json()) as { ok: true; jobId: string; status: "queued" };

    expect(response.status).toBe(200);
    expect(generationQueue.messages).toEqual([{ jobId: json.jobId, spaceId: "space_1" }]);
    expect(images.copyCalls.map((call) => call.destinationKey)).toEqual([`space_1/${json.jobId}/reference-1.png`]);
    expect(images.putCalls.map((call) => call.key)).toEqual([`space_1/${json.jobId}/mask.png`]);
    expect(db.generationJobInserts[0]).toEqual(
      expect.arrayContaining([
        json.jobId,
        "space_1",
        "edit selected area from existing image",
        "space_1",
        `space_1/${json.jobId}/reference-1.png`,
        `space_1/${json.jobId}/mask.png`,
      ]),
    );
  });

  it("rejects requests that mix uploaded reference images with source image ids", async () => {
    const formData = new FormData();
    formData.set("prompt", "bad edit request");
    formData.set("aspectRatio", "1:1");
    formData.set("width", "1024");
    formData.set("height", "1024");
    formData.set("quality", "auto");
    formData.set("quantity", "1");
    formData.set("outputFormat", "png");
    formData.set("compression", "100");
    formData.set("sourceImageId", "img_1");
    formData.set("referenceImage", new File(["reference-bytes"], "source.png", { type: "image/png" }));

    const response = await app.request(
      "http://local.test/api/generations",
      {
        method: "POST",
        headers: { Cookie: "image2_session=test-token" },
        body: formData,
      },
      testEnv({ images: new FakeObjectStore(), generationQueue: new RecordingQueue() }),
    );
    const json = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(400);
    expect(json.error.code).toBe("reference_source_conflict");
  });

  it("rejects more than eight uploaded reference images", async () => {
    const formData = new FormData();
    formData.set("prompt", "too many references");
    formData.set("aspectRatio", "1:1");
    formData.set("width", "1024");
    formData.set("height", "1024");
    formData.set("quality", "auto");
    formData.set("quantity", "1");
    formData.set("outputFormat", "png");
    formData.set("compression", "100");
    for (let index = 0; index < 9; index += 1) {
      formData.append("referenceImage", new File(["reference-bytes"], `reference-${index + 1}.png`, { type: "image/png" }));
    }

    const response = await app.request(
      "http://local.test/api/generations",
      {
        method: "POST",
        headers: { Cookie: "image2_session=test-token" },
        body: formData,
      },
      testEnv({ images: new FakeObjectStore(), generationQueue: new RecordingQueue() }),
    );
    const json = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(400);
    expect(json.error.code).toBe("too_many_reference_images");
  });

  it("rejects source image ids outside the current space", async () => {
    const db = new FakeRouteDatabase();
    db.imageRecords.set("foreign_img", makeImageRecord({ id: "foreign_img", space_id: "space_2", storage_key: "space_2/foreign_img.png" }));

    const response = await app.request(
      "http://local.test/api/generations",
      {
        method: "POST",
        headers: { Cookie: "image2_session=test-token", "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "edit foreign image",
          aspectRatio: "1:1",
          width: 1024,
          height: 1024,
          quality: "auto",
          quantity: 1,
          outputFormat: "png",
          compression: 100,
          sourceImageId: "foreign_img",
        }),
      },
      testEnv({ db, images: new FakeObjectStore(), generationQueue: new RecordingQueue() }),
    );
    const json = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(404);
    expect(json.error.code).toBe("source_image_not_found");
  });
});

describe("generation regenerate", () => {
  it("inherits the original conversation id when regenerating", async () => {
    const db = new FakeRouteDatabase();
    db.jobRecords.set("job_source", makeJobRecord({
      id: "job_source",
      prompt: "原始创作",
      conversation_id: "job_root",
      reference_images_json: JSON.stringify([{ storageKey: "space_1/job_source/reference-1.png", mimeType: "image/png", name: "ref.png", byteSize: 12 }]),
    }));
    const images = new FakeObjectStore();
    const generationQueue = new RecordingQueue();

    const response = await app.request(
      "http://local.test/api/generations/job_source/regenerate",
      {
        method: "POST",
        headers: { Cookie: "image2_session=test-token" },
      },
      testEnv({ db, images, generationQueue }),
    );
    const json = (await response.json()) as { ok: true; jobId: string; status: "queued" };

    expect(response.status).toBe(200);
    expect(generationQueue.messages).toEqual([{ jobId: json.jobId, spaceId: "space_1" }]);
    expect(db.generationJobInserts[0]).toEqual(
      expect.arrayContaining([
        json.jobId,
        "space_1",
        "原始创作",
        "space_1",
        "job_root",
      ]),
    );
  });
});

describe("space login", () => {
  it("allows existing spaces to continue using shorter legacy passwords", async () => {
    const db = new FakeAuthDatabase();
    db.spaceRecords.set(
      "legacy space",
      makeSpaceRecord({
        id: "spc_legacy",
        space_name: "Legacy Space",
        space_key: "legacy space",
        password_hash: await hashPassword("123456"),
      }),
    );

    const response = await app.request(
      "http://local.test/api/auth/space-login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spaceName: "Legacy Space", password: "123456" }),
      },
      testEnv({ db, images: new FakeObjectStore() }),
    );
    const json = (await response.json()) as { ok: true; spaceId: string };

    expect(response.status).toBe(200);
    expect(json.spaceId).toBe("spc_legacy");
    expect(db.sessionInserts).toHaveLength(1);
  });

  it("still rejects short passwords when creating a brand-new space", async () => {
    const response = await app.request(
      "http://local.test/api/auth/space-login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spaceName: "Fresh Space", password: "123456" }),
      },
      testEnv({ db: new FakeAuthDatabase(), images: new FakeObjectStore() }),
    );
    const json = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(400);
    expect(json.error.code).toBe("invalid_password");
    expect(json.error.message).toContain("新空间密码至少需要 8 个字符");
  });
});

function testEnv({
  db = new FakeRouteDatabase(),
  images,
  generationQueue = disabledQueue(),
}: {
  db?: AppDatabase;
  images: AppObjectStore;
  generationQueue?: Env["GENERATION_QUEUE"];
}): Env {
  return {
    DB: db,
    IMAGES: images,
    GENERATION_QUEUE: generationQueue,
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
  readonly generationJobInserts: unknown[][] = [];
  readonly imageRecords = new Map<string, ImageAssetRecord>([["img_1", makeImageRecord()]]);
  readonly jobRecords = new Map<string, Record<string, unknown>>();

  prepare(query: string): AppPreparedStatement {
    return new FakeRoutePreparedStatement(this, query);
  }
}

class FakeAuthDatabase implements AppDatabase {
  readonly spaceRecords = new Map<string, SpaceRecord>();
  readonly sessionInserts: unknown[][] = [];

  prepare(query: string): AppPreparedStatement {
    return new FakeAuthPreparedStatement(this, query);
  }
}

class FakeAuthPreparedStatement implements AppPreparedStatement {
  private values: unknown[] = [];

  constructor(
    private readonly db: FakeAuthDatabase,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): AppPreparedStatement {
    this.values = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    if (this.query.includes("SELECT * FROM spaces WHERE space_key = ?")) {
      return (this.db.spaceRecords.get(String(this.values[0] ?? "")) as T | undefined) ?? null;
    }
    return null;
  }

  async all<T = unknown>(): Promise<{ results?: T[] }> {
    return { results: [] };
  }

  async run(): Promise<unknown> {
    if (this.query.includes("INSERT INTO spaces")) {
      const [id, spaceName, spaceKey, passwordHash] = this.values;
      this.db.spaceRecords.set(
        String(spaceKey),
        makeSpaceRecord({
          id: String(id),
          space_name: String(spaceName),
          space_key: String(spaceKey),
          password_hash: String(passwordHash),
        }),
      );
    }
    if (this.query.includes("INSERT INTO space_sessions")) {
      this.db.sessionInserts.push([...this.values]);
    }
    return { success: true };
  }
}

class FakeRoutePreparedStatement implements AppPreparedStatement {
  private values: unknown[] = [];

  constructor(
    private readonly db: FakeRouteDatabase,
    private readonly query: string,
  ) {}

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
      const image = this.db.imageRecords.get(String(this.values[0] ?? ""));
      return image && image.space_id === this.values[1] ? (image as T) : null;
    }
    if (this.query.includes("SELECT * FROM generation_jobs WHERE id = ? AND space_id = ?")) {
      const job = this.db.jobRecords.get(String(this.values[0] ?? ""));
      return job && job.space_id === this.values[1] ? (job as T) : null;
    }
    if (this.query.includes("FROM api_credentials")) {
      return {
        id: "cred_1",
        space_id: "space_1",
        base_url: "https://token.fourj.space/v1",
        model: "gpt-image-2",
        prompt_optimizer_model: "gpt-5.5",
        encrypted_api_key: "encrypted",
        api_key_hint: "test",
        last_test_ok: 1,
        last_tested_at: "2026-05-15T00:00:00.000Z",
        prompt_base_url: "https://api.openai.com/v1",
        prompt_encrypted_api_key: "prompt-encrypted",
        prompt_api_key_hint: "prompt-test",
        prompt_last_test_ok: 1,
        prompt_last_tested_at: "2026-05-15T00:00:00.000Z",
        created_at: "2026-05-15T00:00:00.000Z",
        updated_at: "2026-05-15T00:00:00.000Z",
      } as T;
    }
    if (this.query.includes("COUNT(*) AS count FROM generation_jobs")) {
      return { count: 0 } as T;
    }
    return null;
  }

  async all<T = unknown>(): Promise<{ results?: T[] }> {
    if (this.query.includes("FROM generation_jobs") && this.query.includes("ORDER BY created_at DESC")) {
      return {
        results: Array.from(this.db.jobRecords.values()) as T[],
      };
    }
    if (this.query.includes("FROM image_assets") && this.query.includes("job_id IN")) {
      const jobIds = new Set(this.values.slice(1).map(String));
      return {
        results: Array.from(this.db.imageRecords.values()).filter((image) => jobIds.has(image.job_id)) as T[],
      };
    }
    return { results: [] };
  }

  async run(): Promise<unknown> {
    if (this.query.includes("INSERT INTO generation_jobs")) {
      this.db.generationJobInserts.push([...this.values]);
    }
    return { success: true };
  }
}

class FakeObjectStore implements AppObjectStore {
  readonly getCalls: string[] = [];
  readonly putCalls: Array<{ key: string; value: unknown; options?: AppObjectStorePutOptions }> = [];
  readonly copyCalls: Array<{ sourceKey: string; destinationKey: string; options?: AppObjectStorePutOptions }> = [];
  readonly presignedCalls: string[] = [];

  constructor(private readonly options: { presignedUrl?: string } = {}) {}

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | Blob | ReadableStream | string,
    options?: AppObjectStorePutOptions,
  ): Promise<unknown> {
    this.putCalls.push({ key, value, options });
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

  async copy(sourceKey: string, destinationKey: string, options?: AppObjectStorePutOptions): Promise<unknown> {
    this.copyCalls.push({ sourceKey, destinationKey, options });
    return {};
  }

  async delete(_key: string): Promise<void> {}

  async createPresignedGetUrl(key: string): Promise<string> {
    this.presignedCalls.push(key);
    if (!this.options.presignedUrl) throw new Error("Presigned URL is not configured.");
    return this.options.presignedUrl;
  }
}

function makeImageRecord(overrides: Partial<ImageAssetRecord> = {}): ImageAssetRecord {
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
    ...overrides,
  };
}

function makeJobRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "job_1",
    space_id: "space_1",
    status: "succeeded",
    prompt: "默认创作",
    aspect_ratio: "1:1",
    width: 1024,
    height: 1024,
    quality: "auto",
    quantity: 1,
    output_format: "png",
    background: "auto",
    compression: null,
    moderation: "auto",
    model: "gpt-image-2",
    base_url_hash: "space_1",
    reference_image_storage_key: null,
    reference_image_mime_type: null,
    reference_image_name: null,
    reference_image_byte_size: null,
    reference_images_json: null,
    mask_image_storage_key: null,
    mask_image_mime_type: null,
    mask_image_name: null,
    mask_image_byte_size: null,
    conversation_id: "job_1",
    stage: "completed",
    progress_current: 1,
    progress_total: 1,
    error_reason: null,
    revised_prompt: null,
    usage_json: null,
    error_code: null,
    error_message: null,
    created_at: "2026-05-15T00:00:00.000Z",
    started_at: "2026-05-15T00:00:00.000Z",
    completed_at: "2026-05-15T00:01:00.000Z",
    ...overrides,
  };
}

function makeSpaceRecord(overrides: Partial<SpaceRecord> = {}): SpaceRecord {
  return {
    id: "spc_1",
    space_name: "Test Space",
    space_key: "test-space",
    password_hash: "hash",
    created_at: "2026-05-15T00:00:00.000Z",
    updated_at: "2026-05-15T00:00:00.000Z",
    ...overrides,
  };
}

class RecordingQueue {
  readonly messages: Array<{ jobId: string; spaceId: string }> = [];

  async send(message: { jobId: string; spaceId: string }): Promise<void> {
    this.messages.push(message);
  }
}
