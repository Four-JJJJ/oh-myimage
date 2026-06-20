import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const calendarSource = readFileSync(new URL("./calendar.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
const unescapedDayButtonBackgroundClass = "[&_.rdp-day" + "_button]:bg-white ";

describe("calendar visual contract", () => {
  it("uses a 12px radius on the gallery date-range picker trigger", () => {
    expect(appSource).toContain('className="h-9 min-w-[224px] justify-start rounded-[12px]');
  });

  it("fills range start and end dates with white at 90% opacity", () => {
    expect(calendarSource).toContain("[&>button]:bg-white/90");
    expect(calendarSource).not.toContain("[&>button]:bg-white ");
    expect(calendarSource).not.toContain(unescapedDayButtonBackgroundClass);
  });
});
