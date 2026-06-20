import { describe, expect, it } from "vitest";
import { resolvePreviewApiDecision } from "./preview-bootstrap";

describe("preview api bootstrap", () => {
  it("keeps the preview api out of normal production loads", () => {
    expect(resolvePreviewApiDecision("", null, "ohmyimage.fourj.space")).toEqual({
      load: false,
      clearStoredMode: false,
    });
  });

  it("loads the preview api only when an allowed host asks for preview mode", () => {
    expect(resolvePreviewApiDecision("?preview=generating", null, "dev-gen.fourj.space")).toEqual({
      load: true,
      clearStoredMode: false,
    });
    expect(resolvePreviewApiDecision("", "empty", "localhost")).toEqual({
      load: true,
      clearStoredMode: false,
    });
  });

  it("clears stored preview mode without loading the preview api when preview is off", () => {
    expect(resolvePreviewApiDecision("?preview=off", "generating", "dev-gen.fourj.space")).toEqual({
      load: false,
      clearStoredMode: true,
    });
  });
});
