import { describe, expect, it } from "vitest";
import { currentSpaceId, currentSpaceName } from "./App";

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
});
