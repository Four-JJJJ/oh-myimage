import { describe, expect, it } from "vitest";
import { deleteStorageKeys } from "./index";

describe("deleteStorageKeys", () => {
  it("deletes every key with bounded concurrency", async () => {
    const deleted: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const store = {
      async delete(key: string) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        deleted.push(key);
        inFlight -= 1;
      },
    };
    const keys = Array.from({ length: 30 }, (_, index) => `space/job/key_${index}`);
    await deleteStorageKeys(store, new Set(keys), 4);
    expect(deleted.sort()).toEqual([...keys].sort());
    expect(peak).toBe(4);
  });

  it("keeps deleting the remaining keys and rethrows the first failure", async () => {
    const deleted: string[] = [];
    const store = {
      async delete(key: string) {
        if (key === "b") throw new Error("boom");
        deleted.push(key);
      },
    };
    await expect(deleteStorageKeys(store, ["a", "b", "c", "d"], 2)).rejects.toThrow("boom");
    expect(deleted.sort()).toEqual(["a", "c", "d"]);
  });

  it("is a no-op for an empty key set", async () => {
    await expect(deleteStorageKeys({ delete: async () => { throw new Error("unexpected"); } }, [])).resolves.toBeUndefined();
  });
});
