import { afterEach, describe, expect, it, vi } from "vitest";
import { app, hasUnlimitedDailyImageQuota } from "./index";
import { sha256Hex } from "./crypto";
import type {
  AppDatabase,
  AppObject,
  AppObjectStore,
  AppObjectStorePutOptions,
  AppPreparedStatement,
  CredentialRecord,
  Env,
  GenerationJobRecord,
  ImageAssetRecord,
  SpaceRecord,
} from "./types";

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe("provider config safety", () => {
  it("requires a new API key when saved provider baseURL origin changes", async () => {
    const db = new FakeRouteDatabase();

    const response = await app.request(
      "http://local.test/api/settings/provider",
      {
        method: "POST",
        headers: { Cookie: "image2_session=test-token", "Content-Type": "application/json" },
        body: JSON.stringify({
          baseURL: "https://api.openai.com/v1",
          model: "gpt-image-2",
          promptOptimizerModel: "gpt-5.5",
        }),
      },
      testEnv({ db, images: new FakeObjectStore() }),
    );
    const json = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(400);
    expect(json.error.code).toBe("invalid_api_key");
    expect(json.error.message).toContain("baseURL");
    expect(db.credentialWrites).toEqual([]);
  });

  it("requires a new API key when testing a different provider origin", async () => {
    const response = await app.request(
      "http://local.test/api/provider/test",
      {
        method: "POST",
        headers: { Cookie: "image2_session=test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ baseURL: "https://api.openai.com/v1" }),
      },
      testEnv({ images: new FakeObjectStore() }),
    );
    const json = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(400);
    expect(json.error.code).toBe("invalid_api_key");
  });

  it("allows model updates to reuse the saved key when baseURL origin is unchanged", async () => {
    const db = new FakeRouteDatabase();

    const response = await app.request(
      "http://local.test/api/settings/provider",
      {
        method: "POST",
        headers: { Cookie: "image2_session=test-token", "Content-Type": "application/json" },
        body: JSON.stringify({
          baseURL: "https://token.fourj.space/v1",
          model: "gpt-image-2",
          promptOptimizerModel: "gpt-5.4",
        }),
      },
      testEnv({ db, images: new FakeObjectStore() }),
    );
    const json = (await response.json()) as { ok: true; provider: { apiKeyHint: string; promptOptimizerModel: string } };

    expect(response.status).toBe(200);
    expect(json.provider.apiKeyHint).toBe("test");
    expect(json.provider.promptOptimizerModel).toBe("gpt-5.4");
    expect(db.credentialWrites[0]).toEqual(
      expect.arrayContaining(["https://token.fourj.space/v1", "gpt-image-2", "gpt-5.4", "encrypted", "test", "space_1"]),
    );
  });

  it("rejects provider baseURLs that resolve to private addresses when a resolver is configured", async () => {
    const db = new FakeRouteDatabase();

    const response = await app.request(
      "http://local.test/api/settings/provider",
      {
        method: "POST",
        headers: { Cookie: "image2_session=test-token", "Content-Type": "application/json" },
        body: JSON.stringify({
          baseURL: "https://token.fourj.space/v1",
          apiKey: "sk-test-key",
          model: "gpt-image-2",
          promptOptimizerModel: "gpt-5.5",
        }),
      },
      testEnv({
        db,
        images: new FakeObjectStore(),
        resolveBaseUrlAddresses: async () => ["10.0.0.8"],
      }),
    );
    const json = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(400);
    expect(json.error.code).toBe("invalid_base_url");
    expect(json.error.message).toContain("private");
    expect(db.credentialWrites).toEqual([]);
  });

  it("rejects non-allowlisted provider baseURLs when DNS resolver is unavailable", async () => {
    const db = new FakeRouteDatabase();

    const response = await app.request(
      "http://local.test/api/settings/provider",
      {
        method: "POST",
        headers: { Cookie: "image2_session=test-token", "Content-Type": "application/json" },
        body: JSON.stringify({
          baseURL: "https://custom-provider.example/v1",
          apiKey: "sk-test-key",
          model: "gpt-image-2",
          promptOptimizerModel: "gpt-5.5",
        }),
      },
      testEnv({ db, images: new FakeObjectStore() }),
    );
    const json = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(400);
    expect(json.error.code).toBe("invalid_base_url");
    expect(json.error.message).toContain("DNS 安全校验");
    expect(db.credentialWrites).toEqual([]);
  });
});

describe("space login rate limiting", () => {
  it("blocks repeated failed logins for the same space and client IP", async () => {
    const db = new FakeRouteDatabase();
    const headers = { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.10" };
    const body = JSON.stringify({ spaceName: "Test Space", password: "wrong-pass" });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.request("http://local.test/api/auth/space-login", { method: "POST", headers, body }, testEnv({ db, images: new FakeObjectStore() }));
      expect(response.status).toBe(401);
    }

    const blocked = await app.request("http://local.test/api/auth/space-login", { method: "POST", headers, body }, testEnv({ db, images: new FakeObjectStore() }));
    const json = (await blocked.json()) as { error: { code: string } };

    expect(blocked.status).toBe(429);
    expect(json.error.code).toBe("space_login_rate_limited");
    expect(db.rateLimitEvents).toHaveLength(5);
    expect(new Set(db.rateLimitEvents.map((event) => event.eventType)).size).toBe(1);
    expect(db.rateLimitEvents[0]?.eventType).toMatch(/^space_login_failure:/);
  });

  it("does not trust spoofable forwarded IP headers by default", async () => {
    const db = new FakeRouteDatabase();
    const body = JSON.stringify({ spaceName: "Test Space", password: "wrong-pass" });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.request(
        "http://local.test/api/auth/space-login",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Forwarded-For": `198.51.100.${attempt + 1}` },
          body,
        },
        testEnv({ db, images: new FakeObjectStore() }),
      );
      expect(response.status).toBe(401);
    }

    const blocked = await app.request(
      "http://local.test/api/auth/space-login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": "198.51.100.99" },
        body,
      },
      testEnv({ db, images: new FakeObjectStore() }),
    );
    const json = (await blocked.json()) as { error: { code: string } };

    expect(blocked.status).toBe(429);
    expect(json.error.code).toBe("space_login_rate_limited");
    expect(new Set(db.rateLimitEvents.map((event) => event.eventType)).size).toBe(1);
  });

  it("records security events when creating new spaces", async () => {
    const db = new FakeRouteDatabase();
    const response = await app.request(
      "http://local.test/api/auth/space-login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.20" },
        body: JSON.stringify({ spaceName: "Fresh Space", password: "new-space-password" }),
      },
      testEnv({ db, images: new FakeObjectStore() }),
    );
    const json = (await response.json()) as { ok: true; spaceName: string };

    expect(response.status).toBe(200);
    expect(json.spaceName).toBe("Fresh Space");
    expect(db.spaces.has("fresh space")).toBe(true);
    expect(db.securityEvents).toEqual([
      {
        eventKey: `ip:${(await sha256Hex("203.0.113.20")).slice(0, 32)}`,
        eventType: "space_creation",
      },
    ]);
  });

  it("blocks new space creation bursts for the same client IP", async () => {
    const db = new FakeRouteDatabase();
    const eventKey = `ip:${(await sha256Hex("203.0.113.21")).slice(0, 32)}`;
    db.securityEvents.push(
      ...Array.from({ length: 10 }, () => ({
        eventKey,
        eventType: "space_creation",
      })),
    );

    const response = await app.request(
      "http://local.test/api/auth/space-login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.21" },
        body: JSON.stringify({ spaceName: "Blocked Fresh Space", password: "new-space-password" }),
      },
      testEnv({ db, images: new FakeObjectStore() }),
    );
    const json = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(429);
    expect(json.error.code).toBe("space_creation_rate_limited");
    expect(db.spaces.has("blocked fresh space")).toBe(false);
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
      `space_1/${json.jobId}/reference.png`,
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
        `space_1/${json.jobId}/reference.png`,
        `space_1/${json.jobId}/mask.png`,
      ]),
    );
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
    expect(images.copyCalls.map((call) => [call.sourceKey, call.destinationKey])).toEqual([["space_1/img_1.png", `space_1/${json.jobId}/reference.png`]]);
    expect(images.putCalls).toEqual([]);
    expect(db.generationJobInserts[0]).toEqual(
      expect.arrayContaining([
        json.jobId,
        "space_1",
        "edit from existing image",
        "space_1",
        `space_1/${json.jobId}/reference.png`,
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
    expect(images.copyCalls.map((call) => call.destinationKey)).toEqual([`space_1/${json.jobId}/reference.png`]);
    expect(images.putCalls.map((call) => call.key)).toEqual([`space_1/${json.jobId}/mask.png`]);
    expect(db.generationJobInserts[0]).toEqual(
      expect.arrayContaining([
        json.jobId,
        "space_1",
        "edit selected area from existing image",
        "space_1",
        `space_1/${json.jobId}/reference.png`,
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

  it("marks jobs failed when queue send fails after job creation", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = new FakeRouteDatabase();

    const response = await app.request(
      "http://local.test/api/generations",
      {
        method: "POST",
        headers: { Cookie: "image2_session=test-token", "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "queue failure cleanup",
          aspectRatio: "1:1",
          width: 1024,
          height: 1024,
          quality: "auto",
          quantity: 1,
          outputFormat: "png",
          compression: 100,
        }),
      },
      testEnv({ db, images: new FakeObjectStore(), generationQueue: new FailingQueue() }),
    );
    const json = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(503);
    expect(json.error.code).toBe("queue_send_failed");
    expect(db.generationJobInserts).toHaveLength(1);
    expect(db.generationJobStatusUpdates).toHaveLength(1);
    expect(db.generationJobStatusUpdates[0]).toEqual(
      expect.arrayContaining(["failed", "queue_send_failed", "生成任务入队失败，请稍后重试。", db.generationJobInserts[0]?.[0]]),
    );
  });

  it("requires Turnstile before regenerating when it is enabled", async () => {
    const db = new FakeRouteDatabase();
    const generationQueue = new RecordingQueue();

    const response = await app.request(
      "http://local.test/api/generations/job_1/regenerate",
      {
        method: "POST",
        headers: { Cookie: "image2_session=test-token" },
      },
      testEnv({
        db,
        images: new FakeObjectStore(),
        generationQueue,
        turnstileRequired: "true",
        turnstileSecretKey: "test-secret",
      }),
    );
    const json = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(403);
    expect(json.error.code).toBe("turnstile_failed");
    expect(db.generationJobInserts).toEqual([]);
    expect(generationQueue.messages).toEqual([]);
  });
});

function testEnv({
  db = new FakeRouteDatabase(),
  images,
  generationQueue = disabledQueue(),
  resolveBaseUrlAddresses,
  providerBaseUrlAllowlist,
  turnstileRequired,
  turnstileSecretKey,
}: {
  db?: AppDatabase;
  images: AppObjectStore;
  generationQueue?: Env["GENERATION_QUEUE"];
  resolveBaseUrlAddresses?: Env["RESOLVE_BASE_URL_ADDRESSES"];
  providerBaseUrlAllowlist?: string;
  turnstileRequired?: string;
  turnstileSecretKey?: string;
}): Env {
  return {
    DB: db,
    IMAGES: images,
    GENERATION_QUEUE: generationQueue,
    INSPIRATION_QUEUE: disabledQueue(),
    RESOLVE_BASE_URL_ADDRESSES: resolveBaseUrlAddresses,
    PROVIDER_BASE_URL_ALLOWLIST: providerBaseUrlAllowlist,
    TURNSTILE_REQUIRED: turnstileRequired,
    TURNSTILE_SECRET_KEY: turnstileSecretKey,
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
  readonly generationJobStatusUpdates: unknown[][] = [];
  readonly credentialWrites: unknown[][] = [];
  readonly rateLimitEvents: Array<{ spaceId: string; eventType: string }> = [];
  readonly securityEvents: Array<{ eventKey: string; eventType: string }> = [];
  readonly generationJobs = new Map<string, GenerationJobRecord>([["job_1", makeGenerationJobRecord()]]);
  readonly imageRecords = new Map<string, ImageAssetRecord>([["img_1", makeImageRecord()]]);
  readonly spaces = new Map<string, SpaceRecord>([["test space", makeSpaceRecord()]]);
  credential: CredentialRecord | null = makeCredentialRecord();

  prepare(query: string): AppPreparedStatement {
    return new FakeRoutePreparedStatement(this, query);
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
    if (this.query.includes("FROM spaces WHERE space_key")) {
      return (this.db.spaces.get(String(this.values[0] ?? "")) ?? null) as T | null;
    }
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
    if (this.query.includes("COUNT(*) AS count")) {
      const eventType = String(this.values[1] ?? "");
      if (this.query.includes("security_events")) {
        const eventKey = String(this.values[0] ?? "");
        return {
          count: this.db.securityEvents.filter((event) => event.eventKey === eventKey && event.eventType === eventType).length,
        } as T;
      }
      if (this.query.includes("rate_limit_events") && eventType.startsWith("space_login_failure:")) {
        const spaceId = String(this.values[0] ?? "");
        return {
          count: this.db.rateLimitEvents.filter((event) => event.spaceId === spaceId && event.eventType === eventType).length,
        } as T;
      }
      return { count: 0 } as T;
    }
    if (this.query.includes("FROM image_assets")) {
      const image = this.db.imageRecords.get(String(this.values[0] ?? ""));
      return image && image.space_id === this.values[1] ? (image as T) : null;
    }
    if (this.query.includes("FROM generation_jobs WHERE id = ? AND space_id = ?")) {
      const job = this.db.generationJobs.get(String(this.values[0] ?? ""));
      return job && job.space_id === this.values[1] ? (job as T) : null;
    }
    if (this.query.includes("FROM api_credentials")) {
      return this.db.credential as T | null;
    }
    return null;
  }

  async all<T = unknown>(): Promise<{ results?: T[] }> {
    return { results: [] };
  }

  async run(): Promise<unknown> {
    if (this.query.includes("INSERT INTO spaces")) {
      const [id, spaceName, spaceKey, passwordHash] = this.values;
      this.db.spaces.set(
        String(spaceKey),
        makeSpaceRecord({
          id: String(id),
          space_name: String(spaceName),
          space_key: String(spaceKey),
          password_hash: String(passwordHash),
        }),
      );
    }
    if (this.query.includes("INSERT INTO generation_jobs")) {
      this.db.generationJobInserts.push([...this.values]);
    }
    if (this.query.includes("UPDATE generation_jobs")) {
      this.db.generationJobStatusUpdates.push([...this.values]);
    }
    if (this.query.includes("INSERT INTO rate_limit_events")) {
      this.db.rateLimitEvents.push({ spaceId: String(this.values[1] ?? ""), eventType: String(this.values[2] ?? "") });
    }
    if (this.query.includes("INSERT INTO security_events")) {
      this.db.securityEvents.push({ eventKey: String(this.values[1] ?? ""), eventType: String(this.values[2] ?? "") });
    }
    if (this.query.includes("UPDATE api_credentials") || this.query.includes("INSERT INTO api_credentials")) {
      this.db.credentialWrites.push([...this.values]);
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

function makeGenerationJobRecord(overrides: Partial<GenerationJobRecord> = {}): GenerationJobRecord {
  return {
    id: "job_1",
    space_id: "space_1",
    status: "succeeded",
    prompt: "regenerate this",
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
    base_url_hash: "hash",
    reference_image_storage_key: null,
    reference_image_mime_type: null,
    reference_image_name: null,
    reference_image_byte_size: null,
    mask_image_storage_key: null,
    mask_image_mime_type: null,
    mask_image_name: null,
    mask_image_byte_size: null,
    revised_prompt: null,
    usage_json: null,
    error_code: null,
    error_message: null,
    created_at: "2026-05-15T00:00:00.000Z",
    started_at: null,
    completed_at: "2026-05-15T00:00:01.000Z",
    ...overrides,
  };
}

class RecordingQueue {
  readonly messages: Array<{ jobId: string; spaceId: string }> = [];

  async send(message: { jobId: string; spaceId: string }): Promise<void> {
    this.messages.push(message);
  }
}

class FailingQueue {
  async send(): Promise<void> {
    throw new Error("queue down");
  }
}

function makeSpaceRecord(overrides: Partial<SpaceRecord> = {}): SpaceRecord {
  return {
    id: "space_1",
    space_name: "Test Space",
    space_key: "test space",
    password_hash: "hash",
    created_at: "2026-05-15T00:00:00.000Z",
    updated_at: "2026-05-15T00:00:00.000Z",
    ...overrides,
  };
}

function makeCredentialRecord(overrides: Partial<CredentialRecord> = {}): CredentialRecord {
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
    created_at: "2026-05-15T00:00:00.000Z",
    updated_at: "2026-05-15T00:00:00.000Z",
    ...overrides,
  };
}
