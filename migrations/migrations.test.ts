import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("database migrations", () => {
  it("does not add generated-image thumbnail columns in both D1 initial schema and D1 follow-up migration", () => {
    const initial = readMigration("0001_initial.sql");
    const followUp = readMigration("0012_generated_image_thumbnails.sql");

    const columns = [
      "thumbnail_storage_key",
      "thumbnail_mime_type",
      "thumbnail_byte_size",
      "thumbnail_sha256",
    ];

    for (const column of columns) {
      expect(initial).not.toContain(column);
      expect(followUp).toContain(`ADD COLUMN ${column}`);
    }
  });
});

function readMigration(fileName: string): string {
  return readFileSync(resolve(process.cwd(), "migrations", fileName), "utf8");
}
