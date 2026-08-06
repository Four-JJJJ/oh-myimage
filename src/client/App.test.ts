import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  currentSpaceId,
  currentSpaceName,
  galleryEmptyStateContract,
  galleryImageActionKeys,
  loginEntryGuidanceCopy,
  shouldShowGenerateBooting,
  shouldShowWorkspaceSidebar,
  usesAppShellFrame,
} from "./App";
import type { GenerationRecord } from "./api";
import { entryStatusLoadingLines, entryStatusLoadingLoopLines, entryStatusSurfaceContract, entrySurfaceContract } from "./features/auth/EntryScreens";
import { navGroupAnchorTop } from "./features/generate-shell/AppShell";
import { buildGalleryGroups, galleryHasHiddenDefaultRangeItems } from "./gallery-utils";

const appSource = readFileSync(fileURLToPath(new URL("./App.tsx", import.meta.url)), "utf8");
const generateMenuSource = readFileSync(fileURLToPath(new URL("./features/generate-menu/GenerateMenuView.tsx", import.meta.url)), "utf8");
const dialogSource = readFileSync(fileURLToPath(new URL("./components/ui/dialog.tsx", import.meta.url)), "utf8");

describe("App safety helpers", () => {
  it("returns undefined when the current space is not ready yet", () => {
    expect(currentSpaceId(null)).toBeUndefined();
    expect(currentSpaceId({ space: undefined as never, providerConfigured: false })).toBeUndefined();
  });

  it("returns the current space id when /api/me has loaded", () => {
    expect(
      currentSpaceId({
        space: { id: "space_1", name: "测试空间" },
        providerConfigured: true,
      }),
    ).toBe("space_1");
  });

  it("returns undefined when the current space name is missing", () => {
    expect(currentSpaceName(null)).toBeUndefined();
    expect(currentSpaceName({ space: { id: "space_1", name: "   " }, providerConfigured: false })).toBeUndefined();
  });

  it("keeps the generate, gallery, settings, and inspiration views inside the current app shell frame", () => {
    expect(usesAppShellFrame("generate")).toBe(true);
    expect(usesAppShellFrame("gallery")).toBe(true);
    expect(usesAppShellFrame("settings")).toBe(true);
    expect(usesAppShellFrame("inspiration")).toBe(true);
  });

  it("only keeps the secondary sidebar on the generate workspace", () => {
    expect(shouldShowWorkspaceSidebar("generate")).toBe(true);
    expect(shouldShowWorkspaceSidebar("gallery")).toBe(false);
    expect(shouldShowWorkspaceSidebar("settings")).toBe(false);
    expect(shouldShowWorkspaceSidebar("inspiration")).toBe(false);
  });

  it("pins the four primary nav entries as one group to a fixed sidebar height percentage", () => {
    expect(navGroupAnchorTop).toBe("37.56%");
  });

  it("keeps the gallery image toolbar aligned with the new preview action order", () => {
    expect(galleryImageActionKeys()).toEqual(["continue", "local-edit", "jump-to-message", "regenerate", "copy", "download", "delete"]);
  });

  it("opens gallery images with the same large-image preview used by generation results", () => {
    expect(appSource).toContain("ImagePreview");
    expect(appSource).not.toContain("ImagePreviewDialog");
    expect(appSource).not.toContain("image-preview-actions");
    expect(appSource).not.toContain("编辑图片</span>");
    expect(appSource).not.toContain("下载图片</span>");
    expect(appSource).toContain("thumbnailUrl: previewItem.image.thumbnailUrl");
  });

  it("uses generated thumbnails for compact generation record thumbnails when available", () => {
    const thumbnailSource = appSource.slice(appSource.indexOf("function GenerationThumbnail"), appSource.indexOf("type ImageSelectionMaskFactory"));

    expect(thumbnailSource).toContain("image.thumbnailUrl ?? image.url");
  });

  it("uses generated thumbnails for gallery cards when available", () => {
    const galleryCardSource = appSource.slice(appSource.indexOf("function GalleryImageCard"), appSource.indexOf("function InspirationPlaceholderView"));

    expect(galleryCardSource).toContain("item.image.thumbnailUrl ?? item.image.url");
    expect(galleryCardSource).not.toContain("src={item.image.url}");
  });

  it("mounts the shared image preview at the document body so it covers the whole app shell", () => {
    expect(generateMenuSource).toContain("createPortal(");
    expect(generateMenuSource).toContain("document.body");
    expect(generateMenuSource).toContain("z-[100]");
  });

  it("uses the same backdrop surface as the local-edit dialog for image preview", () => {
    expect(dialogSource).toContain('dialogBackdropSurfaceClassName = "backdrop-blur-sm"');
    expect(dialogSource).not.toContain("bg-black/72");
    expect(dialogSource).not.toContain("bg-[rgba(0,0,0,0.72)]");
    expect(generateMenuSource).toContain("dialogBackdropSurfaceClassName");
    expect(generateMenuSource).not.toContain("bg-black/72");
    expect(generateMenuSource).not.toContain("bg-[rgba(0,0,0,0.72)]");
    expect(generateMenuSource).not.toContain("bg-[rgba(5,5,5,0.92)]");
  });

  it("keeps image preview free of extra glow, tint, border, and shadow surfaces", () => {
    expect(generateMenuSource).not.toContain("opacity-32 blur-3xl");
    expect(generateMenuSource).not.toContain("scale-110 object-contain");
    expect(generateMenuSource).not.toContain("border border-white/10 bg-white/[0.04]");
    expect(generateMenuSource).not.toContain("shadow-[0_24px_90px_rgb(0_0_0/0.52)]");
  });

  it("lets the local-edit dialog grow to the viewport while keeping its current size as the minimum", () => {
    expect(generateMenuSource).toContain("min-h-[70dvh]");
    expect(generateMenuSource).toContain("h-[80dvh]");
    expect(generateMenuSource).toContain("w-[80vw]");
    expect(generateMenuSource).toContain("!max-w-[80vw]");
    expect(generateMenuSource).toContain("max-h-[80dvh]");
    expect(generateMenuSource).toContain("lg:grid-cols-[minmax(0,1fr)_228px]");
    expect(generateMenuSource).not.toContain("h-[70dvh] max-h-[70dvh] max-w-[70vw]");
  });

  it("keeps settings provider save buttons and notices matched to the screenshot contract", () => {
    const noticeSource = appSource.slice(appSource.indexOf("function Notice"), appSource.indexOf("function sizeForRatioResolution"));
    expect(appSource).toContain("bg-white/90");
    expect(appSource).toContain("text-[#121212]");
    expect(appSource).toContain("hover:bg-white/90");
    expect(noticeSource).toContain("items-center gap-4 rounded-[24px]");
    expect(noticeSource).toContain("size-5 shrink-0");
    expect(noticeSource).not.toContain("items-start gap-3");
    expect(noticeSource).not.toContain("mt-0.5 shrink-0");
  });

  it("renders the empty gallery as one plain text row without a placeholder card", () => {
    expect(galleryEmptyStateContract(false)).toEqual({
      text: "暂无作品",
      card: false,
      icon: false,
    });
    expect(galleryEmptyStateContract(true)).toEqual({
      text: "暂无作品",
      card: false,
      icon: false,
    });
  });

  it("shows gallery items from the latest 10 local days by default", () => {
    const records = [
      generationRecord("job_today", "2026-06-19T08:00:00.000Z"),
      generationRecord("job_ten_days", "2026-06-10T08:00:00.000Z"),
      generationRecord("job_older", "2026-06-09T08:00:00.000Z"),
    ];

    const groups = buildGalleryGroups(records, null, [], 0, {
      now: new Date("2026-06-19T12:00:00.000Z"),
      showOlderThanDefaultRange: false,
      dateFilter: { from: "", to: "" },
    });

    expect(groups.flatMap((group) => group.items.map((item) => item.image.id))).toEqual(["img_today", "img_ten_days"]);
    expect(galleryHasHiddenDefaultRangeItems(records, null, [], new Date("2026-06-19T12:00:00.000Z"))).toBe(true);
  });

  it("keeps gallery results visible when a stale active job lags behind a completed record", () => {
    const completedRecord = generationRecord("job_done", "2026-06-23T10:09:28.474Z");
    const staleActiveJob = {
      ...completedRecord.job,
      status: "queued",
      stage: "queued",
      completed_at: null,
    } as const;

    const groups = buildGalleryGroups([completedRecord], staleActiveJob, [], 0, {
      now: new Date("2026-06-23T12:00:00.000Z"),
      showOlderThanDefaultRange: false,
      dateFilter: { from: "", to: "" },
    });

    expect(groups.flatMap((group) => group.items.map((item) => item.image.id))).toEqual(["img_done"]);
    expect(groups[0]?.items[0]?.job.status).toBe("succeeded");
  });

  it("reveals older gallery items after loading more", () => {
    const records = [
      generationRecord("job_today", "2026-06-19T08:00:00.000Z"),
      generationRecord("job_older", "2026-06-09T08:00:00.000Z"),
    ];

    const groups = buildGalleryGroups(records, null, [], 0, {
      now: new Date("2026-06-19T12:00:00.000Z"),
      showOlderThanDefaultRange: true,
      dateFilter: { from: "", to: "" },
    });

    expect(groups.flatMap((group) => group.items.map((item) => item.image.id))).toEqual(["img_today", "img_older"]);
  });

  it("filters gallery items by single-day and multi-day date ranges", () => {
    const records = [
      generationRecord("job_0619", "2026-06-19T08:00:00.000Z"),
      generationRecord("job_0618", "2026-06-18T08:00:00.000Z"),
      generationRecord("job_0617", "2026-06-17T08:00:00.000Z"),
    ];

    const singleDay = buildGalleryGroups(records, null, [], 0, {
      now: new Date("2026-06-19T12:00:00.000Z"),
      showOlderThanDefaultRange: false,
      dateFilter: { from: "2026-06-18", to: "2026-06-18" },
    });
    const multiDay = buildGalleryGroups(records, null, [], 0, {
      now: new Date("2026-06-19T12:00:00.000Z"),
      showOlderThanDefaultRange: false,
      dateFilter: { from: "2026-06-17", to: "2026-06-18" },
    });

    expect(singleDay.flatMap((group) => group.items.map((item) => item.image.id))).toEqual(["img_0618"]);
    expect(multiDay.flatMap((group) => group.items.map((item) => item.image.id))).toEqual(["img_0618", "img_0617"]);
  });

  it("keeps the generate screen in loading mode until the first conversation fetch finishes", () => {
    expect(shouldShowGenerateBooting("generate", null, false)).toBe(false);
    expect(
      shouldShowGenerateBooting(
        "generate",
        { space: { id: "space_1", name: "测试空间" }, providerConfigured: true },
        false,
      ),
    ).toBe(true);
    expect(
      shouldShowGenerateBooting(
        "generate",
        { space: { id: "space_1", name: "测试空间" }, providerConfigured: true },
        true,
      ),
    ).toBe(false);
    expect(
      shouldShowGenerateBooting(
        "gallery",
        { space: { id: "space_1", name: "测试空间" }, providerConfigured: true },
        false,
      ),
    ).toBe(false);
  });

  it("uses generation-style loading copy for the entry status screen", () => {
    expect(entryStatusLoadingLines).toEqual([
      "正在读取会话",
      "正在同步记录",
      "正在恢复画布",
      "正在准备空间",
      "正在连接工作区",
      "正在整理生成状态",
      "正在载入历史图片",
      "正在校准页面",
    ]);
    expect(entryStatusLoadingLines.every((line) => line.startsWith("正在"))).toBe(true);
    expect(entryStatusLoadingLines.some((line) => /开始|完成|结束|即将/.test(line))).toBe(false);
    expect(entryStatusLoadingLoopLines).toEqual([...entryStatusLoadingLines, entryStatusLoadingLines[0]]);
  });

  it("keeps the entry status loading row aligned with the generation status row", () => {
    expect(entryStatusSurfaceContract).toMatchObject({
      card: false,
      iconSize: "14px",
      lineHeight: "22px",
      textSize: "14px",
      reusedGenerationStatus: true,
    });
  });

  it("keeps the workspace login entry as a single centered card on a pure #181818 surface", () => {
    expect(entrySurfaceContract).toMatchObject({
      background: "#181818",
      brand: "Ohmio",
      betaBadge: true,
      brandIcon: false,
      showHeader: false,
      showFeaturePanel: false,
      showDescription: false,
      cardMaxWidth: "560px",
      cardShadow: "none",
      controlRadius: "12px",
      inputBackground: "#1c1c1c",
      primaryButtonBackground: "rgba(255,255,255,0.9)",
    });
  });

  it("explains how new users create a workspace from the login form", () => {
    expect(loginEntryGuidanceCopy).toEqual({
      description: "第一次使用？输入一个新的空间名字，并设置至少 8 位空间密码，点击进入空间后会自动创建。",
      spaceNameHint: "已有空间填写原空间名；新空间填写你想创建的名字。",
      passwordHint: "新空间密码至少 8 位。空间名和密码目前无法找回，请妥善保存。",
    });
  });
});

function generationRecord(id: string, createdAt: string): GenerationRecord {
  return {
    job: {
      id,
      status: "succeeded",
      prompt: id,
      aspect_ratio: "1:1",
      width: 1024,
      height: 1024,
      quality: "auto",
      quantity: 1,
      output_format: "png",
      background: "auto",
      compression: null,
      error_code: null,
      error_message: null,
      created_at: createdAt,
    },
    images: [
      {
        id: id.replace("job_", "img_"),
        jobId: id,
        url: `/${id}.png`,
        width: 1024,
        height: 1024,
        format: "png",
        createdAt,
      },
    ],
    elapsedSeconds: null,
  };
}
