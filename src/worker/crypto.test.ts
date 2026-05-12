import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, hashPassword, verifyPassword } from "./crypto";

describe("crypto helpers", () => {
  it("verifies PBKDF password hashes", async () => {
    const hash = await hashPassword("correct horse battery staple");
    await expect(verifyPassword("correct horse battery staple", hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong password", hash)).resolves.toBe(false);
  });

  it("encrypts and decrypts API keys", async () => {
    const secret = "local-test-encryption-key";
    const encrypted = await encryptSecret("sk-test-value", secret);
    expect(encrypted).not.toContain("sk-test-value");
    await expect(decryptSecret(encrypted, secret)).resolves.toBe("sk-test-value");
  });
});
