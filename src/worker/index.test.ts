import { describe, expect, it, vi } from "vitest";
import { hashPassword, encryptSecret } from "./crypto";
import {
  app,
  resolvePostProcessingRetryAttempts,
  resolvePostProcessingRetryDelaySeconds,
  resolveProviderRetryAttempts,
  normalizeGenerationResults,
  resolveStatusLongPollSeconds,
} from "./index";
import type { AppDatabase, AppObject, AppObjectStore, AppObjectStorePutOptions, AppPreparedStatement, CredentialRecord, Env, GenerationJobRecord, ImageAssetRecord, ImageProviderProfileRecord, SpaceRecord } from "./types";
import { OFFICIAL_IMAGE_MODEL_PRESETS } from "../image-models";

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

describe("generation result status serialization", () => {
  it.each(["failed", "cancelled", "partial_succeeded"] as const)("does not expose stale running result slots for terminal %s jobs", (status) => {
    const job = makeJobRecord({
      status,
      error_code: "provider_upstream_error",
      error_message: "模型服务返回 502，上游服务暂时不可用。",
      completed_at: "2026-11-06T10:00:00.000Z",
    }) as GenerationJobRecord;
    const result = normalizeGenerationResults(job, [{
      id: "res_job_1_0",
      space_id: "space_1",
      job_id: "job_1",
      result_index: 0,
      status: "running",
      image_asset_id: null,
      error_code: null,
      error_message: null,
      started_at: "2026-11-06T09:59:00.000Z",
      completed_at: null,
    }]);

    expect(result[0]).toMatchObject({
      status: "failed",
      errorCode: "provider_upstream_error",
      errorMessage: "模型服务返回 502，上游服务暂时不可用。",
      completedAt: "2026-11-06T10:00:00.000Z",
    });
  });
});

describe("provider settings", () => {
  it.each([200, 404])("persists preset provenance for an empty or unsupported catalog (%s)", async (status) => {
    const db = new FakeRouteDatabase();
    const encryptedApiKey = await encryptSecret("sk-test-provider", "test-encryption-key-for-routes");
    db.imageProviderProfiles.set("profile_1", makeImageProviderProfileRecord({ id: "profile_1", base_url: "https://api.xyaigc.xyz", encrypted_api_key: encryptedApiKey }));
    db.credentialRecord = makeCredentialRecord({ active_image_provider_id: "profile_1" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status })));
    try {
      const response = await app.request("http://local.test/api/settings/provider/discover-models", {
        method: "POST", headers: { Cookie: "image2_session=test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ providerIds: ["profile_1"] }),
      }, testEnv({ db, images: new FakeObjectStore() }));
      const json = await response.json() as { imageProviders: Array<{ models: string[]; modelSource: string; lastTestOk: boolean }> };
      expect(response.status).toBe(200);
      expect(vi.mocked(fetch).mock.calls[0][0]).toBe("https://api.xyaigc.xyz/v1/models");
      expect(json.imageProviders[0]).toMatchObject({ models: [...OFFICIAL_IMAGE_MODEL_PRESETS], modelSource: "preset", lastTestOk: status === 200 });
      expect(JSON.parse(db.imageProviderProfiles.get("profile_1")!.discovered_models_json!)).toEqual({ source: "preset" });
    } finally { vi.unstubAllGlobals(); }
  });

  it("exposes Image 2.5 Flare as the default generation model", async () => {
    const response = await app.request(
      "http://local.test/api/config",
      {},
      testEnv({ db: new FakeRouteDatabase(), images: new FakeObjectStore() }),
    );
    const json = (await response.json()) as { ok: true; config: { model: string; modelOptions: string[] } };

    expect(response.status).toBe(200);
    expect(json.config.model).toBe("gpt-image-2.5-flare");
    expect(json.config.modelOptions).toEqual([
      "gpt-image-2",
      "gpt-image-2.6",
      "gpt-image-2.5-flare",
      "gpt-image-2.5-sunburst",
      "grok-imagine-image",
      "grok-imagine-image-2.0",
      "gemini-2.5-flash-image",
      "gemini-3-pro-image",
      "gemini-3-pro-image-preview",
      "gemini-3.1-flash-image",
      "gemini-3.1-flash-image-preview",
      "gemini-nano-banana-2.1",
    ]);
  });

  it.each(["https://img.share-api.com/v1", "https://img.share-api.com", "https://img.share-api.com/"])("saves and normalizes an image provider without requiring a prompt provider: %s", async (baseURL) => {
    const db = new FakeRouteDatabase();
    db.credentialRecord = null;

    const response = await app.request(
      "http://local.test/api/settings/provider",
      {
        method: "POST",
        headers: { Cookie: "image2_session=test-token", "Content-Type": "application/json" },
        body: JSON.stringify({
          imageProvider: {
            baseURL,
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

  it.each(["https://api.openai.com/v1", "https://api.openai.com"])("normalizes a prompt provider and keeps the image provider: %s", async (baseURL) => {
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
            baseURL,
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

  it("discovers models for every saved provider without a manual test", async () => {
    const db = new FakeRouteDatabase();
    const encryptionKey = "test-encryption-key-for-routes";
    const encryptedApiKey = await encryptSecret("sk-test-provider", encryptionKey);
    db.imageProviderProfiles.set("profile_1", makeImageProviderProfileRecord({ id: "profile_1", base_url: "https://first.example.com/v1", encrypted_api_key: encryptedApiKey }));
    db.imageProviderProfiles.set("profile_2", makeImageProviderProfileRecord({ id: "profile_2", base_url: "https://second.example.com/v1", encrypted_api_key: encryptedApiKey, discovered_models_json: null }));
    db.credentialRecord = makeCredentialRecord({ active_image_provider_id: "profile_1" });
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const href = String(url);
        requestedUrls.push(href);
        const models = href.startsWith("https://first.example.com")
          ? ["gpt-image-2", "gpt-image-2.5-flare"]
          : ["grok-imagine-image"];
        return new Response(JSON.stringify({ data: models.map((id) => ({ id })) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const response = await app.request(
      "http://local.test/api/settings/provider/discover-models",
      {
        method: "POST",
        headers: { Cookie: "image2_session=test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ providerIds: ["profile_1", "profile_2"] }),
      },
      testEnv({ db, images: new FakeObjectStore() }),
    );
    const json = (await response.json()) as {
      ok: true;
      imageProviders: Array<{ id: string; models: string[] }>;
    };

    expect(response.status).toBe(200);
    expect(requestedUrls).toHaveLength(2);
    expect(json.imageProviders.find((profile) => profile.id === "profile_1")?.models).toEqual(["gpt-image-2", "gpt-image-2.5-flare"]);
    expect(json.imageProviders.find((profile) => profile.id === "profile_2")?.models).toEqual(["grok-imagine-image"]);
    vi.unstubAllGlobals();
  });

  it("keeps provider image models that are not in the built-in list verbatim", async () => {
    const db = new FakeRouteDatabase();
    const encryptionKey = "test-encryption-key-for-routes";
    const encryptedApiKey = await encryptSecret("sk-test-provider", encryptionKey);
    db.imageProviderProfiles.set("profile_1", makeImageProviderProfileRecord({ id: "profile_1", base_url: "https://first.example.com/v1", encrypted_api_key: encryptedApiKey }));
    db.credentialRecord = makeCredentialRecord({ active_image_provider_id: "profile_1" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({
          data: [
            { id: "gpt-5.5" },
            { id: "flux-1.1-pro" },
            { id: "gemini-3-pro-image-preview" },
            { id: "flux-1.1-pro" },
          ],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const response = await app.request(
      "http://local.test/api/settings/provider/discover-models",
      {
        method: "POST",
        headers: { Cookie: "image2_session=test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ providerIds: ["profile_1"] }),
      },
      testEnv({ db, images: new FakeObjectStore() }),
    );
    const json = (await response.json()) as {
      ok: true;
      imageProviders: Array<{ id: string; models: string[] }>;
    };

    expect(response.status).toBe(200);
    expect(json.imageProviders.find((profile) => profile.id === "profile_1")?.models).toEqual([
      "gpt-5.5",
      "flux-1.1-pro",
      "gemini-3-pro-image-preview",
    ]);
    vi.unstubAllGlobals();
  });

  it("creates a new image provider profile without stealing the enabled one, then switches to it explicitly", async () => {
    const db = new FakeRouteDatabase();
    db.imageProviderProfiles.set("profile_1", makeImageProviderProfileRecord());
    db.credentialRecord = makeCredentialRecord({ active_image_provider_id: "profile_1" });

    const firstResponse = await app.request(
      "http://local.test/api/settings/provider",
      {
        method: "POST",
        headers: { Cookie: "image2_session=test-token", "Content-Type": "application/json" },
        body: JSON.stringify({
          imageProvider: {
            providerId: null,
            name: "备用 Provider",
            baseURL: "https://img.backup-api.com/v1",
            apiKey: "sk-backup-provider",
            model: "gpt-image-2.5-sunburst",
          },
        }),
      },
      testEnv({ db, images: new FakeObjectStore() }),
    );
    const firstJson = (await firstResponse.json()) as {
      ok: true;
      imageProviders: Array<{ id: string; name: string; baseURL: string; model: string }>;
      activeImageProviderId: string | null;
      imageProvider: { baseURL: string } | null;
    };

    expect(firstResponse.status).toBe(200);
    expect(firstJson.imageProviders).toHaveLength(2);
    const createdProfile = firstJson.imageProviders.find((profile) => profile.name === "备用 Provider");
    expect(createdProfile).toMatchObject({
      name: "备用 Provider",
      baseURL: "https://img.backup-api.com/v1",
      model: "gpt-image-2.5-sunburst",
    });
    // Saving a new profile must not silently become the enabled one.
    expect(firstJson.activeImageProviderId).toBe("profile_1");
    expect(firstJson.imageProvider?.baseURL).toBe("https://token.fourj.space/v1");
    expect(db.credentialRecord).toMatchObject({
      base_url: "https://token.fourj.space/v1",
      active_image_provider_id: "profile_1",
    });
    // Equal timestamps must not turn the last sorted profile into the active one.
    expect(firstJson.imageProviders.at(-1)?.id).toBe("profile_1");

    const selectResponse = await app.request(
      "http://local.test/api/settings/provider/select",
      {
        method: "POST",
        headers: { Cookie: "image2_session=test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: createdProfile?.id }),
      },
      testEnv({ db, images: new FakeObjectStore() }),
    );
    const selectJson = (await selectResponse.json()) as {
      ok: true;
      imageProvider: { baseURL: string; model: string; apiKeyHint: string };
      activeImageProviderId: string | null;
    };

    expect(selectResponse.status).toBe(200);
    expect(selectJson.activeImageProviderId).toBe(createdProfile?.id);
    expect(selectJson.imageProvider).toMatchObject({
      baseURL: "https://img.backup-api.com/v1",
      model: "gpt-image-2.5-sunburst",
    });
    expect(db.credentialRecord).toMatchObject({
      base_url: "https://img.backup-api.com/v1",
      active_image_provider_id: createdProfile?.id,
    });

    const firstProfileId = "profile_1";
    const switchBackResponse = await app.request(
      "http://local.test/api/settings/provider/select",
      {
        method: "POST",
        headers: { Cookie: "image2_session=test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: firstProfileId }),
      },
      testEnv({ db, images: new FakeObjectStore() }),
    );
    const switchBackJson = (await switchBackResponse.json()) as {
      ok: true;
      imageProvider: { baseURL: string; model: string; apiKeyHint: string };
      activeImageProviderId: string | null;
    };

    expect(switchBackResponse.status).toBe(200);
    expect(switchBackJson.activeImageProviderId).toBe(firstProfileId);
    expect(switchBackJson.imageProvider).toMatchObject({
      baseURL: "https://token.fourj.space/v1",
      model: "gpt-image-2",
      apiKeyHint: "test",
    });
    expect(db.credentialRecord).toMatchObject({
      base_url: "https://token.fourj.space/v1",
      model: "gpt-image-2",
      active_image_provider_id: firstProfileId,
    });
  });

  it("keeps the edited active profile selected for legacy save requests without providerId", async () => {
    const db = new FakeRouteDatabase();
    db.imageProviderProfiles.set("profile_1", makeImageProviderProfileRecord());
    db.imageProviderProfiles.set("profile_2", makeImageProviderProfileRecord({ id: "profile_2", name: "备用配置" }));
    db.credentialRecord = makeCredentialRecord({ active_image_provider_id: "profile_1" });

    const response = await app.request("http://local.test/api/settings/provider", {
      method: "POST",
      headers: { Cookie: "image2_session=test-token", "Content-Type": "application/json" },
      body: JSON.stringify({ imageProvider: {
        name: "已更新的主配置",
        baseURL: "https://img.updated-api.com/v1",
        model: "gpt-image-2.5-sunburst",
      } }),
    }, testEnv({ db, images: new FakeObjectStore() }));

    expect(response.status).toBe(200);
    const json = await response.json() as { activeImageProviderId: string; imageProviders: unknown[]; imageProvider: { baseURL: string } };
    expect(json.activeImageProviderId).toBe("profile_1");
    expect(json.imageProviders).toHaveLength(2);
    expect(json.imageProvider.baseURL).toBe("https://img.updated-api.com/v1");
  });

  it("edits a non-enabled profile without touching the enabled one", async () => {
    const db = new FakeRouteDatabase();
    db.imageProviderProfiles.set("profile_1", makeImageProviderProfileRecord());
    db.imageProviderProfiles.set(
      "profile_2",
      makeImageProviderProfileRecord({ id: "profile_2", name: "备用配置", base_url: "https://img.backup-api.com/v1" }),
    );
    db.credentialRecord = makeCredentialRecord({ active_image_provider_id: "profile_1" });

    const response = await app.request("http://local.test/api/settings/provider", {
      method: "POST",
      headers: { Cookie: "image2_session=test-token", "Content-Type": "application/json" },
      body: JSON.stringify({ imageProvider: {
        providerId: "profile_2",
        name: "备用配置",
        baseURL: "https://img.edited-backup.com/v1",
        model: "grok-imagine-image",
      } }),
    }, testEnv({ db, images: new FakeObjectStore() }));

    expect(response.status).toBe(200);
    const json = await response.json() as {
      activeImageProviderId: string;
      imageProviders: Array<{ id: string; baseURL: string }>;
      imageProvider: { baseURL: string };
    };
    expect(json.activeImageProviderId).toBe("profile_1");
    expect(json.imageProviders.find((profile) => profile.id === "profile_2")?.baseURL).toBe("https://img.edited-backup.com/v1");
    // The enabled credential must still point at profile_1's saved values.
    expect(json.imageProvider.baseURL).toBe("https://token.fourj.space/v1");
    expect(db.credentialRecord).toMatchObject({
      base_url: "https://token.fourj.space/v1",
      active_image_provider_id: "profile_1",
    });
  });

  it("switches away from a deleted active profile and keeps one profile", async () => {
    const db = new FakeRouteDatabase();
    db.imageProviderProfiles.set(
      "profile_2",
      makeImageProviderProfileRecord({
        id: "profile_2",
        name: "备用 Provider",
        base_url: "https://img.backup-api.com/v1",
        model: "gpt-image-2.5-flare",
        encrypted_api_key: "backup-encrypted",
        api_key_hint: "sk-b...der",
      }),
    );
    db.credentialRecord = makeCredentialRecord({ active_image_provider_id: "profile_1" });
    db.imageProviderProfiles.set(
      "profile_1",
      makeImageProviderProfileRecord({
        id: "profile_1",
        name: "当前 Provider",
        base_url: db.credentialRecord.base_url,
        model: db.credentialRecord.model,
        encrypted_api_key: db.credentialRecord.encrypted_api_key,
        api_key_hint: db.credentialRecord.api_key_hint,
      }),
    );

    const response = await app.request(
      "http://local.test/api/settings/provider/profiles/profile_1",
      {
        method: "DELETE",
        headers: { Cookie: "image2_session=test-token" },
      },
      testEnv({ db, images: new FakeObjectStore() }),
    );
    const json = (await response.json()) as {
      ok: true;
      imageProviders: Array<{ id: string }>;
      activeImageProviderId: string | null;
      imageProvider: { baseURL: string; model: string };
    };

    expect(response.status).toBe(200);
    expect(json.imageProviders).toHaveLength(1);
    expect(json.imageProviders[0]?.id).toBe("profile_2");
    expect(json.activeImageProviderId).toBe("profile_2");
    expect(json.imageProvider).toMatchObject({
      baseURL: "https://img.backup-api.com/v1",
      model: "gpt-image-2.5-flare",
    });
    expect(db.credentialRecord).toMatchObject({
      active_image_provider_id: "profile_2",
      base_url: "https://img.backup-api.com/v1",
    });

    const lastDeleteResponse = await app.request(
      "http://local.test/api/settings/provider/profiles/profile_2",
      {
        method: "DELETE",
        headers: { Cookie: "image2_session=test-token" },
      },
      testEnv({ db, images: new FakeObjectStore() }),
    );
    expect(lastDeleteResponse.status).toBe(400);
    await expect(lastDeleteResponse.json()).resolves.toMatchObject({ error: { code: "provider_profile_required" } });
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
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, no-cache, must-revalidate, max-age=0");
    expect(response.headers.get("Pragma")).toBe("no-cache");
    expect(response.headers.get("Expires")).toBe("0");
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
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, no-cache, must-revalidate, max-age=0");
    expect(response.headers.get("Pragma")).toBe("no-cache");
    expect(response.headers.get("Expires")).toBe("0");
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

  it("serves GIF originals with the GIF media type", async () => {
    const db = new FakeRouteDatabase();
    db.imageRecords.set("img_1", makeImageRecord({
      storage_key: "space_1/img_1.gif",
      mime_type: "image/gif",
      format: "gif",
    }));
    const images = new FakeObjectStore();
    const response = await app.request(
      "http://local.test/api/images/img_1/download?raw=1",
      { headers: { Cookie: "image2_session=test-token" } },
      testEnv({ db, images }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/gif");
    expect(response.headers.get("Content-Disposition")).toBe('inline; filename="img_1.gif"');
    expect(images.getCalls).toEqual(["space_1/img_1.gif"]);
  });

  it("serves SVG originals with a restrictive content security policy", async () => {
    const db = new FakeRouteDatabase();
    db.imageRecords.set("img_1", makeImageRecord({
      storage_key: "space_1/img_1.svg",
      mime_type: "image/svg+xml",
      format: "svg",
    }));
    const images = new FakeObjectStore();
    const response = await app.request(
      "http://local.test/api/images/img_1/download",
      { headers: { Cookie: "image2_session=test-token" } },
      testEnv({ db, images }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Location")).toBeNull();
    expect(images.presignedCalls).toEqual([]);
    expect(response.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(response.headers.get("Content-Disposition")).toBe('inline; filename="img_1.svg"');
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(images.getCalls).toEqual(["space_1/img_1.svg"]);
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
      "space_1/job_1/img_job_1_0.gif",
      "space_1/job_1/img_job_1_0.svg",
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
  it("uses the requested Image 2.5 Sunburst model for a new generation", async () => {
    const db = new FakeRouteDatabase();
    const generationQueue = new RecordingQueue();

    const response = await app.request(
      "http://local.test/api/generations",
      {
        method: "POST",
        headers: { Cookie: "image2_session=test-token", "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Image 2.5 Sunburst generation",
          model: "gpt-image-2.5-sunburst",
          aspectRatio: "1:1",
          width: 1024,
          height: 1024,
          quality: "auto",
          quantity: 1,
          outputFormat: "png",
          compression: 100,
        }),
      },
      testEnv({ db, images: new FakeObjectStore(), generationQueue }),
    );

    expect(response.status).toBe(200);
    expect(db.generationJobInserts[0]?.[12]).toBe("gpt-image-2.5-sunburst");
  });

  it("ignores legacy daily-quota environment variables", async () => {
    const db = new FakeRouteDatabase();
    const generationQueue = new RecordingQueue();
    const env = Object.assign(testEnv({ db, images: new FakeObjectStore(), generationQueue }), {
      MAX_DAILY_IMAGES_PER_SPACE: "0",
      MAX_DAILY_JOBS_PER_SPACE: "0",
    });

    const response = await app.request(
      "http://local.test/api/generations",
      {
        method: "POST",
        headers: { Cookie: "image2_session=test-token", "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "unlimited daily generation",
          aspectRatio: "1:1",
          width: 1024,
          height: 1024,
          quality: "auto",
          quantity: 1,
          outputFormat: "png",
          compression: 100,
        }),
      },
      env,
    );

    expect(response.status).toBe(200);
    expect(generationQueue.messages).toHaveLength(1);
  });

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
  readonly imageProviderProfiles = new Map<string, ImageProviderProfileRecord>();
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
    if (this.query.includes("SET base_url = (SELECT base_url FROM image_provider_profiles")) {
      const placeholders = this.query.match(/\?/g)?.length ?? 0;
      if (values.length !== placeholders) throw new Error(`Expected ${placeholders} bound parameters, got ${values.length}`);
    }
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
    if (this.query.includes("FROM image_provider_profiles")) {
      const profile = this.db.imageProviderProfiles.get(String(this.values[0] ?? ""));
      return profile && profile.space_id === this.values[1] ? (profile as T) : null;
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
    if (this.query.includes("FROM image_provider_profiles")) {
      return {
        results: Array.from(this.db.imageProviderProfiles.values())
          .filter((profile) => profile.space_id === this.values[0])
          .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id)) as T[],
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
    if (this.query.includes("SET base_url = (SELECT base_url FROM image_provider_profiles")) {
      const profileId = String(this.values[0]);
      const profile = this.db.imageProviderProfiles.get(profileId);
      if (profile && this.db.credentialRecord?.space_id === this.values[1]) {
        this.db.credentialRecord = makeCredentialRecord({
          ...this.db.credentialRecord,
          base_url: profile.base_url,
          model: profile.model,
          encrypted_api_key: profile.encrypted_api_key,
          api_key_hint: profile.api_key_hint,
          active_image_provider_id: profile.id,
        });
      }
    } else if (this.query.includes("UPDATE api_credentials")) {
      const [
        baseURL,
        model,
        encryptedApiKey,
        apiKeyHint,
        promptBaseURL,
        promptModel,
        promptEncryptedApiKey,
        promptApiKeyHint,
        lastTestOk,
        lastTestedAt,
        promptLastTestOk,
        promptLastTestedAt,
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
        last_test_ok: Number(lastTestOk),
        last_tested_at: lastTestedAt === null || lastTestedAt === undefined ? null : String(lastTestedAt),
        prompt_last_test_ok: Number(promptLastTestOk),
        prompt_last_tested_at: promptLastTestedAt === null || promptLastTestedAt === undefined ? null : String(promptLastTestedAt),
      });
    }
    if (this.query.includes("INSERT INTO image_provider_profiles")) {
      const [id, spaceId, name, baseURL, model, encryptedApiKey, apiKeyHint, lastTestOk, lastTestedAt, discoveredModelsJson] = this.values;
      this.db.imageProviderProfiles.set(String(id), {
        id: String(id),
        space_id: String(spaceId),
        name: String(name),
        base_url: String(baseURL),
        model: String(model),
        encrypted_api_key: String(encryptedApiKey),
        api_key_hint: String(apiKeyHint),
        last_test_ok: Number(lastTestOk),
        last_tested_at: lastTestedAt === null ? null : String(lastTestedAt),
        discovered_models_json: discoveredModelsJson === null || discoveredModelsJson === undefined ? null : String(discoveredModelsJson),
        created_at: "2026-05-15T00:00:00.000Z",
        updated_at: "2026-05-15T00:00:00.000Z",
      });
    }
    if (this.query.includes("UPDATE image_provider_profiles") && this.query.includes("discovered_models_json")) {
      const [lastTestOk, discoveredModelsJson, profileId, spaceId] = this.values;
      const profile = this.db.imageProviderProfiles.get(String(profileId));
      if (profile && profile.space_id === spaceId) {
        Object.assign(profile, {
          last_test_ok: Number(lastTestOk),
          last_tested_at: "2026-05-15T00:00:00.000Z",
          discovered_models_json: discoveredModelsJson === null ? null : String(discoveredModelsJson),
        });
      }
    }
    if (this.query.includes("UPDATE image_provider_profiles") && !this.query.includes("discovered_models_json")) {
      const [name, baseURL, model, encryptedApiKey, apiKeyHint, profileId, spaceId] = this.values;
      const profile = this.db.imageProviderProfiles.get(String(profileId));
      if (profile && profile.space_id === spaceId) {
        Object.assign(profile, {
          name: String(name),
          base_url: String(baseURL),
          model: String(model),
          encrypted_api_key: String(encryptedApiKey),
          api_key_hint: String(apiKeyHint),
          last_test_ok: 0,
          last_tested_at: null,
        });
      }
    }
    if (this.query.includes("DELETE FROM image_provider_profiles")) {
      const [profileId, spaceId] = this.values;
      const profile = this.db.imageProviderProfiles.get(String(profileId));
      if (profile?.space_id === spaceId) this.db.imageProviderProfiles.delete(String(profileId));
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

function makeImageProviderProfileRecord(overrides: Partial<ImageProviderProfileRecord> = {}): ImageProviderProfileRecord {
  return {
    id: "profile_1",
    space_id: "space_1",
    name: "默认配置",
    base_url: "https://token.fourj.space/v1",
    model: "gpt-image-2",
    encrypted_api_key: "encrypted",
    api_key_hint: "test",
    last_test_ok: 1,
    last_tested_at: "2026-05-15T00:00:00.000Z",
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

describe("generation status long polling", () => {
  type StatusJson = { version: string; longPollSeconds: number; job: { progress_current: number; status: string } };

  function runningJobDb() {
    const db = new FakeRouteDatabase();
    db.jobRecords.set("job_1", makeJobRecord({ status: "running", stage: "waiting_provider", progress_current: 0, completed_at: null }));
    return db;
  }

  function requestStatus(db: FakeRouteDatabase, query = "", longPoll?: string) {
    return app.request(
      `http://local.test/api/generations/job_1${query}`,
      { headers: { Cookie: "image2_session=test-token" } },
      { ...testEnv({ db, images: new FakeObjectStore() }), STATUS_LONG_POLL_MAX_SECONDS: longPoll },
    );
  }

  it("bounds the configured wait", () => {
    expect(resolveStatusLongPollSeconds(undefined)).toBe(0);
    expect(resolveStatusLongPollSeconds("0")).toBe(0);
    expect(resolveStatusLongPollSeconds("abc")).toBe(0);
    expect(resolveStatusLongPollSeconds("20")).toBe(20);
    expect(resolveStatusLongPollSeconds("999")).toBe(25);
  });

  it("returns a stable version and answers immediately when long polling is disabled", async () => {
    const db = runningJobDb();
    const first = (await (await requestStatus(db)).json()) as StatusJson;
    expect(first.version).toMatch(/^[0-9a-f]{16}$/);
    expect(first.longPollSeconds).toBe(0);

    const startedAt = Date.now();
    const second = (await (await requestStatus(db, `?since=${first.version}&wait=20`)).json()) as StatusJson;
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(second.version).toBe(first.version);
  });

  it("holds a since request until the job changes", async () => {
    const db = runningJobDb();
    const first = (await (await requestStatus(db, "", "5")).json()) as StatusJson;
    expect(first.longPollSeconds).toBe(5);

    setTimeout(() => {
      db.jobRecords.set("job_1", makeJobRecord({ status: "running", stage: "saving", progress_current: 1, completed_at: null }));
    }, 300);
    const startedAt = Date.now();
    const changed = (await (await requestStatus(db, `?since=${first.version}&wait=5`, "5")).json()) as StatusJson;
    const elapsed = Date.now() - startedAt;

    expect(changed.version).not.toBe(first.version);
    expect(changed.job.progress_current).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(3_000);
  });

  it("gives up waiting once the wait budget is spent", async () => {
    const db = runningJobDb();
    const first = (await (await requestStatus(db, "", "5")).json()) as StatusJson;
    const startedAt = Date.now();
    const same = (await (await requestStatus(db, `?since=${first.version}&wait=2`, "5")).json()) as StatusJson;
    expect(same.version).toBe(first.version);
    expect(Date.now() - startedAt).toBeLessThan(2_500);
  });
});
