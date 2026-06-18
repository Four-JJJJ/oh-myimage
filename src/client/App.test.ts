import { describe, expect, it } from "vitest";
import { currentSpaceId, currentSpaceName, galleryImageActionKeys, shouldShowGenerateBooting, shouldShowWorkspaceSidebar, usesAppShellFrame } from "./App";
import { entryStatusLoadingLines, entryStatusLoadingLoopLines, entrySurfaceContract } from "./features/auth/EntryScreens";
import { navGroupAnchorTop } from "./features/generate-shell/AppShell";

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
    expect(galleryImageActionKeys()).toEqual(["continue", "local-edit", "regenerate", "copy", "download", "delete"]);
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
      "正在加载会话消息",
      "正在读取会话记录",
      "正在恢复生成状态",
      "正在准备 coss 工作区",
      "正在同步空间信息",
    ]);
    expect(entryStatusLoadingLines.every((line) => line.startsWith("正在"))).toBe(true);
    expect(entryStatusLoadingLines.some((line) => /开始|完成|结束|即将/.test(line))).toBe(false);
    expect(entryStatusLoadingLoopLines).toEqual([...entryStatusLoadingLines, entryStatusLoadingLines[0]]);
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
      controlRadius: "10px",
      inputBackground: "#1c1c1c",
      primaryButtonBackground: "rgba(255,255,255,0.9)",
    });
  });
});
