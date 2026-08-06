import { describe, expect, it, vi } from "vitest";
import { hashPassword } from "./crypto";
import {
  app,
  hasUnlimitedDailyImageQuota,
  resolvePostProcessingRetryAttempts,
  resolvePostProcessingRetryDelaySeconds,
  resolveProviderRetryAttempts,
} from "./index";
import type { AppDatabase, AppObject, AppObjectStore, AppObjectStorePutOptions, AppPreparedStatement, CredentialRecord, Env, ImageAssetRecord, SpaceRecord } from "./types";

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

  it("keeps a separate bounded retry budget for checkpointed post-processing", () => {
    expect(resolvePostProcessingRetryAttempts(undefined)).toBe(2);
    expect(resolvePostProcessingRetryAttempts("0")).toBe(0);
    expect(resolvePostProcessingRetryAttempts("99")).toBe(4);
    expect(resolvePostProcessingRetryDelaySeconds(undefined)).toBe(5);
    expect(resolvePostProcessingRetryDelaySeconds("99")).toBe(60);
  });
});

describe("provider settings", () => {
  it("saves an image provider without requiring a prompt provider", async () => {
    const db = new FakeRouteDatabase();
    db.credentialRecord = null;

    const response = await app.request(
      "http://local.test/api/settings/provider",
      {
        method: "POST",
        headers: { Cookie: "image2_session=test-token", "Content-Type": "application/json" },
        body: JSON.stringify({
          imageProvider: {
            baseURL: "https://img.share-api.com/v1",
            apiKey: "sk-test-image-provider",
            model: "gpt-image-2",
          },
        }),
      },
      testEnv({ db, images: new FakeObjectStore() }),
    );
    const json = (await response.json()) as { ok: true; imageProvider: { baseURL: string; apiKeyHint: string }; promptProvider: null };

    expect(response.status).toBe(200);
    expect(json.imageProvider.baseURL).toBe("https://img.share-api.com/v1");
    expect(json.imageProvider.apiKeyHint).toBe("sk-t...ider");
    expect(json.promptProvider).toBeNull();
    expect(db.credentialRecord).toMatchObject({
      space_id: "space_1",
      base_url: "https://img.share-api.com/v1",
      model: "gpt-image-2",
      api_key_hint: "sk-t...ider",
      prompt_base_url: null,
      prompt_encrypted_api_key: null,
      prompt_api_key_hint: null,
    });
  });

  it("keeps an existing image provider when saving a prompt provider later", async () => {
    const db = new FakeRouteDatabase();
    db.credentialRecord = makeCredentialRecord({
      base_url: "https://img.share-api.com/v1",
      model: "gpt-image-2",
      encrypted_api_key: "existing-image-secret",
      api_key_hint: "sk-i...mage",
      prompt_base_url: null,
      prompt_encrypted_api_key: null,
      prompt_api_key_hint: null,
    });

    const response = await app.request(
      "http://local.test/api/settings/provider",
      {
        method: "POST",
        headers: { Cookie: "image2_session=test-token", "Content-Type": "application/json" },
        body: JSON.stringify({
          promptProvider: {
            baseURL: "https://api.openai.com/v1",
            apiKey: "sk-test-prompt-provider",
            model: "gpt-5.5",
          },
        }),
      },
      testEnv({ db, images: new FakeObjectStore() }),
    );
    const json = (await response.json()) as { ok: true; imageProvider: { baseURL: string; apiKeyHint: string }; promptProvider: { baseURL: string; apiKeyHint: string } };

    expect(response.status).toBe(200);
    expect(json.imageProvider.baseURL).toBe("https://img.share-api.com/v1");
    expect(json.imageProvider.apiKeyHint).toBe("sk-i...mage");
    expect(json.promptProvider.baseURL).toBe("https://api.openai.com/v1");
    expect(json.promptProvider.apiKeyHint).toBe("sk-t...ider");
    expect(db.credentialRecord).toMatchObject({
      base_url: "https://img.share-api.com/v1",
      encrypted_api_key: "existing-image-secret",
      api_key_hint: "sk-i...mage",
      prompt_base_url: "https://api.openai.com/v1",
      prompt_api_key_hint: "sk-t...ider",
    });
  });
});

describe("image downloads", () => {
  it("uses stable same-origin image URLs for generation records", async () => {
    const db = new FakeRouteDatabase();
    db.jobRecords.set("job_1", makeJobRecord());
    db.imageRecords.set(
      "img_1",
      makeImageRecord({
        thumbnail_storage_key: "space_1/thumbs/img_1.webp",
        thumbnail_mime_type: "image/webp",
        thumbnail_byte_size: 512,
        thumbnail_sha256: "thumb-sha",
      }),
    );
    const response = await app.request(
      "http://local.test/api/generations",
      {
        headers: { Cookie: "image2_session=test-token" },
      },
      testEnv({ db, images: new FakeObjectStore() }),
    );
    const json = (await response.json()) as { records: Array<{ images: Array<{ url: string; thumbnailUrl: string | null }> }> };

    expect(response.status).toBe(200);
    expect(json.records[0]?.images[0]?.url).toBe("/api/images/img_1/download?raw=1");
    expect(json.records[0]?.images[0]?.thumbnailUrl).toBe("/api/images/img_1/thumbnail");
  });

  it("returns generation records in pages of 40 and only exposes a cursor when more exist", async () => {
    const db = new FakeRouteDatabase();
    db.imageRecords.clear();
    for (let index = 0; index < 41; index += 1) {
      const padded = String(index).padStart(2, "0");
      db.jobRecords.set(
        `job_${padded}`,
        makeJobRecord({
          id: `job_${padded}`,
          conversation_id: `job_${padded}`,
          created_at: `2026-05-15T00:${String(40 - index).padStart(2, "0")}:00.000Z`,
        }),
      );
    }

    const response = await app.request(
      "http://local.test/api/generations",
      {
        headers: { Cookie: "image2_session=test-token" },
      },
      testEnv({ db, images: new FakeObjectStore() }),
    );
    const json = (await response.json()) as { records: Array<{ job: { id: string; created_at: string } }>; nextCursor: string | null };

    expect(response.status).toBe(200);
    expect(json.records).toHaveLength(40);
    expect(json.records.at(-1)?.job.id).toBe("job_39");
    expect(json.nextCursor).toBe("2026-05-15T00:01:00.000Z");
  });

  it("does not mutate active generation jobs while reading details", async () => {
    const db = new FakeRouteDatabase();
    db.jobRecords.set(
      "job_1",
      makeJobRecord({
        status: "running",
        stage: "waiting_provider",
        progress_current: 0,
        completed_at: null,
      }),
    );
    db.imageRecords.set("img_1", makeImageRecord({ job_id: "job_1" }));

    const response = await app.request(
      "http://local.test/api/generations/job_1",
      {
        headers: { Cookie: "image2_session=test-token" },
      },
      testEnv({ db, images: new FakeObjectStore() }),
    );
    const json = (await response.json()) as { job: { status: string; stage: string; progress_current: number }; images: unknown[] };

    expect(response.status).toBe(200);
    expect(json.job.status).toBe("running");
    expect(json.job.stage).toBe("waiting_provider");
    expect(json.job.progress_current).toBe(0);
    expect(json.images).toHaveLength(1);
    expect(db.completedJobUpdates).toEqual([]);
  });

  it("does not mutate active generation jobs while reading the list", async () => {
    const db = new FakeRouteDatabase();
    db.jobRecords.set(
      "job_1",
      makeJobRecord({
        status: "running",
        stage: "waiting_provider",
        progress_current: 0,
        completed_at: null,
      }),
    );
    db.imageRecords.set("img_1", makeImageRecord({ job_id: "job_1" }));

    const response = await app.request(
      "http://local.test/api/generations",
      {
        headers: { Cookie: "image2_session=test-token" },
      },
      testEnv({ db, images: new FakeObjectStore() }),
    );
    const json = (await response.json()) as { records: Array<{ job: { status: string; stage: string; progress_current: number } }> };

    expect(response.status).toBe(200);
    expect(json.records[0]?.job.status).toBe("running");
    expect(json.records[0]?.job.stage).toBe("waiting_provider");
    expect(json.records[0]?.job.progress_current).toBe(0);
    expect(db.completedJobUpdates).toEqual([]);
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
    expect(response.headers.get("Content-Length")).toBe("11");
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
    expect(response.headers.get("Content-Length")).toBe("11");
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

  it("returns cached generated thumbnails with long private cache headers", async () => {
    const db = new FakeRouteDatabase();
    db.imageRecords.set(
      "img_1",
      makeImageRecord({
        thumbnail_storage_key: "space_1/thumbs/img_1.webp",
        thumbnail_mime_type: "image/webp",
        thumbnail_byte_size: 512,
        thumbnail_sha256: "thumb-sha",
      }),
    );
    const images = new FakeObjectStore();
    const response = await app.request(
      "http://local.test/api/images/img_1/thumbnail",
      {
        headers: { Cookie: "image2_session=test-token" },
      },
      testEnv({ db, images }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
    expect(response.headers.get("ETag")).toBe('"thumb-sha"');
    expect(response.headers.get("Content-Length")).toBe("512");
    expect(response.headers.get("Content-Disposition")).toBe('inline; filename="img_1-thumbnail.webp"');
    expect(await response.text()).toBe("image-bytes");
    expect(images.getCalls).toEqual(["space_1/thumbs/img_1.webp"]);
  });

  it("returns not modified for cached generated thumbnail reads", async () => {
    const db = new FakeRouteDatabase();
    db.imageRecords.set(
      "img_1",
      makeImageRecord({
        thumbnail_storage_key: "space_1/thumbs/img_1.webp",
        thumbnail_mime_type: "image/webp",
        thumbnail_byte_size: 512,
        thumbnail_sha256: "thumb-sha",
      }),
    );
    const images = new FakeObjectStore();
    const response = await app.request(
      "http://local.test/api/images/img_1/thumbnail",
      {
        headers: { Cookie: "image2_session=test-token", "If-None-Match": '"thumb-sha"' },
      },
      testEnv({ db, images }),
    );

    expect(response.status).toBe(304);
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
    expect(response.headers.get("ETag")).toBe('"thumb-sha"');
    expect(await response.text()).toBe("");
    expect(images.getCalls).toEqual([]);
  });

  it("deletes generated assets, thumbnails, and recovery checkpoints with a completed generation record", async () => {
    const db = new FakeRouteDatabase();
    db.jobRecords.set(
      "job_1",
      makeJobRecord({
        reference_image_storage_key: "space_1/job_1/reference-1.png",
        mask_image_storage_key: "space_1/job_1/mask.png",
      }),
    );
    db.imageRecords.set(
      "img_1",
      makeImageRecord({
        thumbnail_storage_key: "space_1/thumbs/img_1.webp",
        thumbnail_mime_type: "image/webp",
        thumbnail_byte_size: 512,
        thumbnail_sha256: "thumb-sha",
      }),
    );
    const images = new FakeObjectStore();

    const response = await app.request(
      "http://local.test/api/generations/job_1",
      {
        method: "DELETE",
        headers: { Cookie: "image2_session=test-token" },
      },
      testEnv({ db, images }),
    );

    expect(response.status).toBe(200);
    expect(images.deleteCalls).toEqual([
      "space_1/img_1.png",
      "space_1/thumbs/img_1.webp",
      "space_1/job_1/reference-1.png",
      "space_1/job_1/mask.png",
      "space_1/job_1/provider-result-0.json",
      "space_1/job_1/img_job_1_0.png",
      "space_1/job_1/img_job_1_0.jpeg",
      "space_1/job_1/img_job_1_0.webp",
      "space_1/job_1/thumb_img_job_1_0.webp",
    ]);
  });

  it("rejects deletion while a generation job is queued or running", async () => {
    const db = new FakeRouteDatabase();
    db.jobRecords.set("job_1", makeJobRecord({ status: "running", stage: "waiting_provider", completed_at: null }));
    const images = new FakeObjectStore();

    const response = await app.request(
      "http://local.test/api/generations/job_1",
      {
        method: "DELETE",
        headers: { Cookie: "image2_session=test-token" },
      },
      testEnv({ db, images }),
    );
    const json = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(409);
    expect(json.error.code).toBe("job_active");
    expect(images.deleteCalls).toEqual([]);
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

  it("returns reference image bytes with stable private cache headers", async () => {
    const db = new FakeRouteDatabase();
    db.jobRecords.set(
      "job_1",
      makeJobRecord({
        reference_image_storage_key: "space_1/job_1/reference-1.png",
        reference_image_mime_type: "image/png",
        reference_image_name: "source.png",
        reference_image_byte_size: 123,
      }),
    );
    const images = new FakeObjectStore();

    const response = await app.request(
      "http://local.test/api/generations/job_1/references/0",
      {
        headers: { Cookie: "image2_session=test-token" },
      },
      testEnv({ db, images }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
    expect(response.headers.get("ETag")).toBe('"space_1/job_1/reference-1.png:123"');
    expect(images.getCalls).toEqual(["space_1/job_1/reference-1.png"]);
  });

  it("returns not modified for cached reference image reads", async () => {
    const db = new FakeRouteDatabase();
    db.jobRecords.set(
      "job_1",
      makeJobRecord({
        reference_image_storage_key: "space_1/job_1/reference-1.png",
        reference_image_mime_type: "image/png",
        reference_image_name: "source.png",
        reference_image_byte_size: 123,
      }),
    );
    const images = new FakeObjectStore();

    const response = await app.request(
      "http://local.test/api/generations/job_1/references/0",
      {
        headers: { Cookie: "image2_session=test-token", "If-None-Match": '"space_1/job_1/reference-1.png:123"' },
      },
      testEnv({ db, images }),
    );

    expect(response.status).toBe(304);
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
    expect(response.headers.get("ETag")).toBe('"space_1/job_1/reference-1.png:123"');
    expect(images.getCalls).toEqual([]);
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
      expect.objectContaining({ storageKey: `space_1/${json.jobId}/reference-1.png`, name: "source-one.png", mimeType: "image/png", role: "reference" }),
      expect.objectContaining({ storageKey: `space_1/${json.jobId}/reference-2.webp`, name: "source-two.webp", mimeType: "image/webp", role: "reference" }),
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
    expect(JSON.parse(String(db.generationJobInserts[0]?.at(-1)))).toEqual([
      expect.objectContaining({ storageKey: `space_1/${json.jobId}/reference-1.png`, role: "source" }),
    ]);
  });

  it("maps the legacy referenceImageId field to the source-image edit path", async () => {
    const db = new FakeRouteDatabase();
    const images = new FakeObjectStore();
    const generationQueue = new RecordingQueue();

    const response = await app.request(
      "http://local.test/api/generations",
      {
        method: "POST",
        headers: { Cookie: "image2_session=test-token", "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "legacy continued edit",
          aspectRatio: "1:1",
          width: 1024,
          height: 1024,
          quality: "auto",
          quantity: 1,
          outputFormat: "png",
          compression: 100,
          referenceImageId: "img_1",
        }),
      },
      testEnv({ db, images, generationQueue }),
    );
    const json = (await response.json()) as { jobId: string };

    expect(response.status).toBe(200);
    expect(images.copyCalls.map((call) => call.destinationKey)).toEqual([`space_1/${json.jobId}/reference-1.png`]);
    expect(JSON.parse(String(db.generationJobInserts[0]?.at(-1)))).toEqual([
      expect.objectContaining({ role: "source" }),
    ]);
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

  it("marks a newly-created job failed when queue enqueue fails", async () => {
    const db = new FakeRouteDatabase();
    const response = await app.request(
      "http://local.test/api/generations",
      {
        method: "POST",
        headers: { Cookie: "image2_session=test-token", "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "queue failure should not leave a stuck job",
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
    expect(json.error.code).toBe("queue_enqueue_failed");
    expect(db.generationJobInserts).toHaveLength(1);
    expect(db.statusUpdates).toEqual([
      expect.objectContaining({
        jobId: expect.stringMatching(/^job_/),
        status: "failed",
        errorCode: "queue_enqueue_failed",
        stage: "failed",
      }),
    ]);
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

  it("keeps a source image before uploaded references in one generation request", async () => {
    const db = new FakeRouteDatabase();
    const images = new FakeObjectStore();
    const generationQueue = new RecordingQueue();
    const formData = new FormData();
    formData.set("prompt", "continue with a style reference");
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
      testEnv({ db, images, generationQueue }),
    );
    const json = (await response.json()) as { ok: true; jobId: string; status: "queued" };

    expect(response.status).toBe(200);
    expect(json.status).toBe("queued");
    expect(images.copyCalls.map((call) => call.destinationKey)).toEqual([`space_1/${json.jobId}/reference-1.png`]);
    expect(images.putCalls.map((call) => call.key)).toEqual([`space_1/${json.jobId}/reference-2.png`]);
    expect(JSON.parse(String(db.generationJobInserts[0]?.at(-1)))).toEqual([
      expect.objectContaining({ storageKey: `space_1/${json.jobId}/reference-1.png`, role: "source" }),
      expect.objectContaining({ storageKey: `space_1/${json.jobId}/reference-2.png`, name: "source.png", role: "reference" }),
    ]);
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

  it("counts a continued-creation source image toward the eight-reference limit", async () => {
    const images = new FakeObjectStore();
    const formData = new FormData();
    formData.set("prompt", "too many references with a source image");
    formData.set("aspectRatio", "1:1");
    formData.set("width", "1024");
    formData.set("height", "1024");
    formData.set("quality", "auto");
    formData.set("quantity", "1");
    formData.set("outputFormat", "png");
    formData.set("compression", "100");
    formData.set("sourceImageId", "img_1");
    for (let index = 0; index < 8; index += 1) {
      formData.append("referenceImage", new File(["reference-bytes"], `reference-${index + 1}.png`, { type: "image/png" }));
    }

    const response = await app.request(
      "http://local.test/api/generations",
      {
        method: "POST",
        headers: { Cookie: "image2_session=test-token" },
        body: formData,
      },
      testEnv({ images, generationQueue: new RecordingQueue() }),
    );
    const json = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(400);
    expect(json.error.code).toBe("too_many_reference_images");
    expect(images.copyCalls).toEqual([]);
    expect(images.putCalls).toEqual([]);
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

  it("marks regenerated jobs failed when queue enqueue fails", async () => {
    const db = new FakeRouteDatabase();
    db.jobRecords.set("job_source", makeJobRecord({ id: "job_source", prompt: "原始创作", conversation_id: "job_root" }));

    const response = await app.request(
      "http://local.test/api/generations/job_source/regenerate",
      {
        method: "POST",
        headers: { Cookie: "image2_session=test-token" },
      },
      testEnv({ db, images: new FakeObjectStore(), generationQueue: new FailingQueue() }),
    );
    const json = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(503);
    expect(json.error.code).toBe("queue_enqueue_failed");
    expect(db.generationJobInserts).toHaveLength(1);
    expect(db.statusUpdates).toEqual([
      expect.objectContaining({
        jobId: expect.stringMatching(/^job_/),
        status: "failed",
        errorCode: "queue_enqueue_failed",
        stage: "failed",
      }),
    ]);
  });
});

describe("api error logging", () => {
  it("does not log expected HTTP errors such as missing sessions", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await app.request(
        "http://local.test/api/me",
        {
          headers: {},
        },
        testEnv({ images: new FakeObjectStore() }),
      );

      expect(response.status).toBe(401);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
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
    APP_ENCRYPTION_KEY: "test-encryption-key-for-routes",
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
  readonly completedJobUpdates: string[] = [];
  readonly statusUpdates: Array<{ jobId: string; status: string; errorCode: string | null; errorMessage: string | null; stage: string }> = [];
  readonly imageRecords = new Map<string, ImageAssetRecord>([["img_1", makeImageRecord()]]);
  readonly jobRecords = new Map<string, Record<string, unknown>>();
  credentialRecord: CredentialRecord | null = makeCredentialRecord();

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
      return this.db.credentialRecord && this.db.credentialRecord.space_id === this.values[0] ? (this.db.credentialRecord as T) : null;
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
    if (this.query.includes("FROM image_assets") && this.query.includes("WHERE job_id = ? AND space_id = ?")) {
      const [jobId, spaceId] = this.values;
      return {
        results: Array.from(this.db.imageRecords.values()).filter((image) => image.job_id === jobId && image.space_id === spaceId) as T[],
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
    if (this.query.includes("UPDATE generation_jobs") && this.query.includes("stage = 'completed'")) {
      this.db.completedJobUpdates.push(String(this.values.at(-1)));
    }
    if (this.query.includes("UPDATE generation_jobs") && this.query.includes("stage = ?")) {
      this.db.statusUpdates.push({
        status: String(this.values[0] ?? ""),
        errorCode: this.values[1] === null ? null : String(this.values[1]),
        errorMessage: this.values[2] === null ? null : String(this.values[2]),
        stage: String(this.values[4] ?? ""),
        jobId: String(this.values.at(-1) ?? ""),
      });
    }
    if (this.query.includes("INSERT INTO api_credentials")) {
      const [
        id,
        spaceId,
        baseURL,
        model,
        encryptedApiKey,
        apiKeyHint,
        promptBaseURL,
        promptModel,
        promptEncryptedApiKey,
        promptApiKeyHint,
      ] = this.values;
      this.db.credentialRecord = makeCredentialRecord({
        id: String(id),
        space_id: String(spaceId),
        base_url: String(baseURL),
        model: String(model),
        encrypted_api_key: String(encryptedApiKey),
        api_key_hint: String(apiKeyHint),
        prompt_base_url: promptBaseURL === null || promptBaseURL === undefined ? null : String(promptBaseURL),
        prompt_optimizer_model: String(promptModel),
        prompt_encrypted_api_key: promptEncryptedApiKey === null || promptEncryptedApiKey === undefined ? null : String(promptEncryptedApiKey),
        prompt_api_key_hint: promptApiKeyHint === null || promptApiKeyHint === undefined ? null : String(promptApiKeyHint),
      });
    }
    if (this.query.includes("UPDATE api_credentials")) {
      const [
        baseURL,
        model,
        encryptedApiKey,
        apiKeyHint,
        promptBaseURL,
        promptModel,
        promptEncryptedApiKey,
        promptApiKeyHint,
        spaceId,
      ] = this.values;
      this.db.credentialRecord = makeCredentialRecord({
        ...(this.db.credentialRecord ?? {}),
        space_id: String(spaceId),
        base_url: String(baseURL),
        model: String(model),
        encrypted_api_key: String(encryptedApiKey),
        api_key_hint: String(apiKeyHint),
        prompt_base_url: promptBaseURL === null || promptBaseURL === undefined ? null : String(promptBaseURL),
        prompt_optimizer_model: String(promptModel),
        prompt_encrypted_api_key: promptEncryptedApiKey === null || promptEncryptedApiKey === undefined ? null : String(promptEncryptedApiKey),
        prompt_api_key_hint: promptApiKeyHint === null || promptApiKeyHint === undefined ? null : String(promptApiKeyHint),
      });
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

  readonly deleteCalls: string[] = [];

  async delete(key: string): Promise<void> {
    this.deleteCalls.push(key);
  }

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
    thumbnail_storage_key: null,
    thumbnail_mime_type: null,
    thumbnail_byte_size: null,
    thumbnail_sha256: null,
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
    prompt_base_url: "https://api.openai.com/v1",
    prompt_encrypted_api_key: "prompt-encrypted",
    prompt_api_key_hint: "prompt-test",
    prompt_last_test_ok: 1,
    prompt_last_tested_at: "2026-05-15T00:00:00.000Z",
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

class FailingQueue {
  async send(): Promise<void> {
    throw new Error("queue unavailable");
  }
}
