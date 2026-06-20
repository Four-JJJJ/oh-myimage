import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const alertDialogPath = new URL("./alert-dialog.tsx", import.meta.url);
const alertDialogSource = existsSync(alertDialogPath) ? readFileSync(alertDialogPath, "utf8") : "";
const buttonSource = readFileSync(new URL("./button.tsx", import.meta.url), "utf8");

describe("alert dialog visual contract", () => {
  it("uses Base UI AlertDialog primitives for destructive confirmations", () => {
    expect(alertDialogSource).toContain('@base-ui/react/alert-dialog');
    expect(alertDialogSource).toContain("AlertDialogPrimitive.Popup");
    expect(alertDialogSource).toContain("AlertDialogPrimitive.Backdrop");
  });

  it("defaults to the new dark destructive confirmation treatment", () => {
    expect(alertDialogSource).toContain("bg-[#202020]");
    expect(alertDialogSource).toContain("border-white/[0.12]");
    expect(alertDialogSource).toContain("border-t border-white/[0.08]");
    expect(alertDialogSource).toContain("backdrop-blur-md");
    expect(alertDialogSource).not.toContain("AlertDialogIcon");
    expect(buttonSource).toContain("bg-[#ff4050]");
    expect(buttonSource).toContain("hover:bg-[#ff4b5a]");
  });

  it("exposes a destructive outline button variant", () => {
    expect(buttonSource).toContain('"destructive-outline"');
    expect(buttonSource).toContain("variant === \"destructive-outline\"");
  });
});
