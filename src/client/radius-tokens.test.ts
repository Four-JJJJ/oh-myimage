import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const clientRoot = dirname(fileURLToPath(import.meta.url));
const allowedRadiusValues = new Set(["6px", "8px", "12px", "16px", "24px"]);
const allowedRoundedExceptions = new Set(["rounded-none", "rounded-full", "rounded-[999px]", "rounded-[inherit]"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) return sourceFiles(path);
    if (!/\.(css|ts|tsx)$/.test(entry) || /\.test\.(ts|tsx)$/.test(entry)) return [];
    return [path];
  });
}

function isAllowedRoundedToken(token: string): boolean {
  if (allowedRoundedExceptions.has(token)) return true;
  const value = token.match(/^\!?rounded(?:-[lrtbxy])?-\[([^\]]+)\]$/)?.[1];
  return Boolean(value && allowedRadiusValues.has(value));
}

function isAllowedBorderRadius(value: string): boolean {
  const normalized = value.trim();
  if (normalized === "0" || normalized === "0 !important") return true;
  if (normalized === "999px") return true;
  if (normalized.startsWith("var(")) return true;
  return allowedRadiusValues.has(normalized);
}

describe("radius token contract", () => {
  it("keeps visual radii on the approved scale", () => {
    const violations: string[] = [];

    for (const file of sourceFiles(clientRoot)) {
      const source = readFileSync(file, "utf8");
      const rel = relative(clientRoot, file);

      for (const match of source.matchAll(/\!?rounded(?:-[lrtbxy])?(?:-\[[^\]]+\]|-[a-z0-9]+)?(?=[\s"')}`])/g)) {
        const token = match[0].replace(/^!/, "");
        if (!isAllowedRoundedToken(token)) violations.push(`${rel}: ${token}`);
      }

      for (const match of source.matchAll(/border-radius:\s*([^;"\]\s]+(?:\s*!important)?)/g)) {
        const value = match[1];
        if (!isAllowedBorderRadius(value)) violations.push(`${rel}: border-radius: ${value}`);
      }
    }

    expect(violations).toEqual([]);
  });
});
