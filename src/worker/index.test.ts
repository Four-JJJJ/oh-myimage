import { describe, expect, it } from "vitest";
import { hasUnlimitedDailyImageQuota } from "./index";

describe("daily image quota exemption", () => {
  it("exempts Small Token providers without requiring a connection test", () => {
    expect(hasUnlimitedDailyImageQuota({ base_url: "https://token.fourj.space/v1" })).toBe(true);
    expect(hasUnlimitedDailyImageQuota({ base_url: "https://image.fourj.space/v1" })).toBe(true);
  });

  it("does not exempt other provider URLs", () => {
    expect(hasUnlimitedDailyImageQuota({ base_url: "https://api.openai.com/v1" })).toBe(false);
  });
});
