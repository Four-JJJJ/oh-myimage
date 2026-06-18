import { describe, expect, it } from "vitest";
import type { GenerationRecord } from "../../api";
import {
  buildConversationRecords,
  buildConversationList,
  buildGenerationFlowItem,
  mergeJobReferenceImages,
  buildSidebarConversations,
  conversationIdForRecord,
  composerDraftFromRecord,
  createDraftConversation,
  resolveDefaultActiveConversationId,
  resolveLatestVisibleConversationId,
  submittedReferenceImages,
  truncateConversationTitle,
  updateDraftConversationTitle,
} from "./mappers";

function record(overrides: Partial<GenerationRecord["job"]> = {}, images: GenerationRecord["images"] = []): GenerationRecord {
  return {
    elapsedSeconds: 89,
    images,
    job: {
      id: "job_1",
      status: "succeeded",
      prompt: "默认创作默认创作默认创作默认创作",
      aspect_ratio: "16:9",
      width: 1536,
      height: 864,
      quality: "auto",
      quantity: 1,
      output_format: "png",
      background: "auto",
      compression: null,
      error_code: null,
      error_message: null,
      created_at: "2026-06-14T08:12:00.000Z",
      ...overrides,
    },
  };
}

describe("generate menu mappers", () => {
  it("truncates long prompts into compact conversation titles", () => {
    expect(truncateConversationTitle("  默认创作默认创作默认创作默认创作  ")).toBe("默认创作默认创作默认创作...");
    expect(truncateConversationTitle("短提示")).toBe("短提示");
    expect(truncateConversationTitle("")).toBe("新的创作");
  });

  it("groups generation records into dated conversation list items", () => {
    const items = buildConversationList([
      record({ id: "job_today", created_at: "2026-06-14T08:12:00.000Z" }, [
        { id: "img_1", jobId: "job_today", url: "/img.png", width: 100, height: 100, format: "png", createdAt: "2026-06-14T08:13:00.000Z" },
      ]),
      record({ id: "job_old", created_at: "2026-06-12T08:12:00.000Z", prompt: "旧记录" }),
    ], new Date("2026-06-14T12:00:00.000Z"));

    expect(items).toMatchObject([
      { id: "job_today", title: "默认创作默认创作默认创作...", groupLabel: "今天", previewImage: "/img.png" },
      { id: "job_old", title: "旧记录", groupLabel: "6月12日", previewImage: null },
    ]);
  });

  it("prepends a new draft conversation ahead of stored records", () => {
    const draft = createDraftConversation(new Date("2026-06-14T12:00:00.000Z"));
    const items = buildSidebarConversations([record({ id: "job_old", created_at: "2026-06-12T08:12:00.000Z", prompt: "旧记录" })], draft, {}, new Date("2026-06-14T12:00:00.000Z"));

    expect(items).toMatchObject([
      { id: "draft-conversation-1781438400000", title: "新的创作", groupLabel: "今天", previewImage: null, isDraft: true },
      { id: "job_old", title: "旧记录", groupLabel: "6月12日", previewImage: null },
    ]);
  });

  it("keeps repeated submissions inside the same sidebar conversation", () => {
    const items = buildSidebarConversations(
      [
        record({ id: "job_child", created_at: "2026-06-14T09:12:00.000Z", prompt: "第二次创作" }, [
          { id: "img_child", jobId: "job_child", url: "/child.png", width: 100, height: 100, format: "png", createdAt: "2026-06-14T09:13:00.000Z" },
        ]),
        record({ id: "job_root", created_at: "2026-06-14T08:12:00.000Z", prompt: "第一次创作" }),
      ],
      null,
      { job_child: "job_root", job_root: "job_root" },
      new Date("2026-06-14T12:00:00.000Z"),
    );

    expect(items).toMatchObject([
      {
        id: "job_root",
        title: "第一次创作",
        previewImage: "/child.png",
        latestRecordId: "job_child",
        groupLabel: "今天",
      },
    ]);
  });

  it("uses persisted conversation ids when rebuilding the sidebar from reloaded records", () => {
    const items = buildSidebarConversations(
      [
        record({ id: "job_child", conversation_id: "job_root", created_at: "2026-06-14T09:12:00.000Z", prompt: "第二次创作" }, [
          { id: "img_child", jobId: "job_child", url: "/child.png", width: 100, height: 100, format: "png", createdAt: "2026-06-14T09:13:00.000Z" },
        ]),
        record({ id: "job_root", conversation_id: "job_root", created_at: "2026-06-14T08:12:00.000Z", prompt: "第一次创作" }),
      ],
      null,
      {},
      new Date("2026-06-14T12:00:00.000Z"),
    );

    expect(items).toMatchObject([
      {
        id: "job_root",
        title: "第一次创作",
        previewImage: "/child.png",
        latestRecordId: "job_child",
        groupLabel: "今天",
      },
    ]);
  });

  it("resolves the default active conversation to the root conversation id", () => {
    const records = [
      record({ id: "job_child", conversation_id: "job_root", created_at: "2026-06-14T09:12:00.000Z", prompt: "第二次创作" }),
      record({ id: "job_root", conversation_id: "job_root", created_at: "2026-06-14T08:12:00.000Z", prompt: "第一次创作" }),
    ];

    expect(resolveDefaultActiveConversationId(records)).toBe("job_root");
    expect(conversationIdForRecord(records[0])).toBe("job_root");
  });

  it("falls back to the latest visible conversation when a draft is present", () => {
    const draft = createDraftConversation(new Date("2026-06-14T12:00:00.000Z"));
    const conversations = buildSidebarConversations(
      [record({ id: "job_root", conversation_id: "job_root", created_at: "2026-06-14T08:12:00.000Z", prompt: "第一次创作" })],
      draft,
      {},
      new Date("2026-06-14T12:00:00.000Z"),
    );

    expect(resolveLatestVisibleConversationId(conversations)).toBe("job_root");
  });

  it("uses the first user prompt as the draft conversation title", () => {
    const draft = createDraftConversation(new Date("2026-06-14T12:00:00.000Z"));

    expect(updateDraftConversationTitle(draft, "   ")).toMatchObject({ title: "新的创作" });
    expect(updateDraftConversationTitle(draft, "一只在黑色摄影棚里发光的玻璃猫，产品海报风格")).toMatchObject({
      title: "一只在黑色摄影棚里发光的...",
    });
  });

  it("wraps records into flow items with pending and success states", () => {
    expect(buildGenerationFlowItem(record({ status: "running" })).status).toBe("pending");
    expect(buildGenerationFlowItem(record({ status: "queued" })).status).toBe("pending");
    expect(buildGenerationFlowItem(record({ status: "failed" })).status).toBe("failed");
    expect(buildGenerationFlowItem(record({ status: "succeeded" })).status).toBe("success");
  });

  it("keeps submitted reference images when a refreshed job omits them", () => {
    const submittedJob = record({
      id: "job_with_reference",
      referenceImages: [{ name: "参考图 1", mimeType: "image/png", byteSize: 128, url: "blob:reference-1" }],
    }).job;
    const refreshedJob = record({ id: "job_with_reference", status: "running", referenceImages: [] }).job;

    expect(mergeJobReferenceImages(refreshedJob, submittedJob).referenceImages).toEqual(submittedJob.referenceImages);
  });

  it("prefers reference images returned by the refreshed job", () => {
    const submittedJob = record({
      id: "job_with_reference",
      referenceImages: [{ name: "参考图 1", mimeType: "image/png", byteSize: 128, url: "blob:reference-1" }],
    }).job;
    const refreshedJob = record({
      id: "job_with_reference",
      status: "running",
      referenceImages: [{ name: "source.png", mimeType: "image/png", byteSize: 256, url: "/api/generations/job_with_reference/references/0" }],
    }).job;

    expect(mergeJobReferenceImages(refreshedJob, submittedJob).referenceImages).toEqual([
      { name: "参考图 1", mimeType: "image/png", byteSize: 256, url: "/api/generations/job_with_reference/references/0" },
    ]);
  });

  it("preserves semantic submitted reference labels after refresh", () => {
    const submittedJob = record({
      id: "job_with_reference",
      referenceImages: [{ name: "参考图 1", mimeType: "image/png", byteSize: 128, url: "blob:reference-1" }],
    }).job;
    const refreshedJob = record({
      id: "job_with_reference",
      status: "running",
      referenceImages: [{ name: "Codex Pro 分组价格.jpg", mimeType: "image/png", byteSize: 256, url: "/api/generations/job_with_reference/references/0" }],
    }).job;

    expect(mergeJobReferenceImages(refreshedJob, submittedJob).referenceImages).toEqual([
      { name: "参考图 1", mimeType: "image/png", byteSize: 256, url: "/api/generations/job_with_reference/references/0" },
    ]);
  });

  it("falls back to the continue-from-image preview when no uploaded reference image exists", () => {
    expect(
      submittedReferenceImages([], { name: "参考图 1", url: "blob:continue-source" }),
    ).toEqual([
      { name: "参考图 1", mimeType: "image/png", byteSize: 0, url: "blob:continue-source" },
    ]);
  });

  it("preserves custom submitted reference names such as local edit previews", () => {
    expect(
      submittedReferenceImages([
        {
          name: "局部重绘",
          file: { type: "image/webp", size: 2048 },
          url: "blob:local-edit-reference",
        },
      ]),
    ).toEqual([
      { name: "局部重绘", mimeType: "image/webp", byteSize: 2048, url: "blob:local-edit-reference" },
    ]);
  });

  it("uses a single local edit preview for source edits", () => {
    expect(
      submittedReferenceImages(
        [],
        { name: "局部重绘", url: "blob:local-edit-source" },
      ),
    ).toEqual([
      { name: "局部重绘", mimeType: "image/png", byteSize: 0, url: "blob:local-edit-source" },
    ]);
  });

  it("preserves the local edit preview after server refresh", () => {
    const submittedJob = record({
      id: "job_local_edit",
      referenceImages: [
        { name: "局部重绘", mimeType: "image/png", byteSize: 0, url: "blob:local-edit-source" },
      ],
    }).job;
    const refreshedJob = record({
      id: "job_local_edit",
      status: "running",
      referenceImages: [
        { name: "img_job_1.png", mimeType: "image/png", byteSize: 256, url: "/api/generations/job_local_edit/references/0" },
      ],
    }).job;

    expect(mergeJobReferenceImages(refreshedJob, submittedJob).referenceImages).toEqual([
      { name: "局部重绘", mimeType: "image/png", byteSize: 256, url: "blob:local-edit-source" },
    ]);
  });

  it("creates a composer draft from a previous record for continued creation", () => {
    const draft = composerDraftFromRecord(record({ id: "job_continue", prompt: "继续加强光影" }));

    expect(draft).toMatchObject({
      prompt: "继续加强光影",
      selectedModel: "gpt-image-2",
      selectedQuality: "auto",
      mode: "remix",
      sourceRecordId: "job_continue",
    });
  });

  it("returns every record in a conversation ordered from earliest to latest", () => {
    const items = buildConversationRecords(
      [
        record({ id: "job_3", created_at: "2026-06-14T10:12:00.000Z", prompt: "第三次创作" }),
        record({ id: "job_1", created_at: "2026-06-14T08:12:00.000Z", prompt: "第一次创作" }),
        record({ id: "job_2", created_at: "2026-06-14T09:12:00.000Z", prompt: "第二次创作" }),
      ],
      { job_1: "job_1", job_2: "job_1", job_3: "job_1" },
      "job_1",
    );

    expect(items.map((item) => item.job.id)).toEqual(["job_1", "job_2", "job_3"]);
  });
});
